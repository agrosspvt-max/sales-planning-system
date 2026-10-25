/**
 * Framework-agnostic autosave engine for a keyed map of editable cells (Sales Seasonal / Monthly, Recovery Month / Week). Extracted from the React hook so the
 * ordering rules can be unit-tested without a DOM — the same approach as the Daily Work AutosaveController, adapted to per-cell revisions.
 *
 * GUARANTEES:
 *  - At most ONE save is in flight per controller (one editor = one save stream). An edit made while saving stays pending and goes out in ONE trailing save.
 *  - Every edit gets a revision. A successful save acknowledges only the exact revisions it sent: a cell edited again while the request was in flight stays
 *    dirty and is sent again with its NEWER value. A retry always sends the CURRENT value, so an older value can never overwrite a newer edit.
 *  - Rapid edits are coalesced by the debounce (latest value wins; nothing is lost). A value equal to what the server already holds is not sent.
 *  - Hydration (reset) is not an edit. A reset (another plan / version) drops the old stream; a response that belongs to the previous stream is ignored.
 *  - A FAILED save keeps its cells dirty and reports `failed` (with the server's message). Only TRANSIENT failures (network, 5xx, 408, 429) are retried, with
 *    bounded backoff; the saves are absolute values (SET, never increments), so repeating one is safe. A refused save (409 locked / 403 / 422) is not repeated:
 *    the edits stay visible as unsaved until the person changes something or presses Save.
 */
export interface AutosaveMapHost<T> {
  persist: (keys: string[], snapshot: Record<string, T>) => Promise<void>;
  onState?: (state: AutosaveMapState<T>) => void;
  delay?: number;
  maxRetries?: number;
  backoff?: (attempt: number) => number;
  isTransient?: (err: unknown) => boolean;
  equals?: (a: T | undefined, b: T | undefined) => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface AutosaveMapState<T> {
  values: Record<string, T>;
  saving: boolean;
  failed: boolean;
  error: string | null;
  /** Cells with edits the server has not confirmed yet. */
  pending: number;
}

const defaultTransient = (err: unknown): boolean => {
  const status = (err as { status?: number } | null)?.status;
  return status === undefined || status >= 500 || status === 408 || status === 429;
};
const defaultBackoff = (attempt: number): number => Math.min(8000, 2000 * 2 ** (attempt - 1)); // 2 s, 4 s, 8 s
const defaultEquals = <T,>(a: T | undefined, b: T | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

export class AutosaveMapController<T> {
  private readonly host: AutosaveMapHost<T>;
  private values: Record<string, T>;
  private persisted: Record<string, T>;
  private dirty = new Map<string, number>(); // key → latest unsaved revision
  private sending = new Set<string>(); // keys inside the in-flight request
  private revision = 0;
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private timer: unknown = null;
  private attempts = 0;
  private failed = false;
  private error: unknown = null;
  private disposed = false;

  constructor(initial: Record<string, T>, host: AutosaveMapHost<T>) {
    this.host = host;
    this.values = { ...initial };
    this.persisted = { ...initial };
  }

  get state(): AutosaveMapState<T> {
    return { values: this.values, saving: this.inFlight !== null, failed: this.failed, error: this.failed ? messageOf(this.error) : null, pending: this.dirty.size };
  }

  /**
   * A new stream (another plan / version / server baseline): nothing pending carries over, and late responses of the old stream are ignored. Edits of the
   * old stream that were still pending are handed to `saveOld` — the OLD stream's own persist — so leaving one plan for another never sends them to the new
   * plan's endpoint and never silently drops them.
   */
  reset(initial: Record<string, T>, saveOld?: (keys: string[], snapshot: Record<string, T>) => Promise<void>): void {
    if (saveOld && this.dirty.size > 0) void saveOld([...this.dirty.keys()], { ...this.values }).catch(() => undefined);
    this.generation++;
    this.clear();
    this.values = { ...initial };
    this.persisted = { ...initial };
    this.dirty.clear();
    this.sending.clear();
    this.inFlight = null;
    this.attempts = 0;
    this.failed = false;
    this.error = null;
    this.emit();
  }

  update(key: string, next: T): void {
    if (this.disposed) return;
    this.values = { ...this.values, [key]: next };
    // Back to what the server holds and not inside a request → nothing to send for this cell.
    if (!this.sending.has(key) && (this.host.equals ?? defaultEquals)(next, this.persisted[key])) this.dirty.delete(key);
    else this.dirty.set(key, ++this.revision);
    this.attempts = 0; // a genuine edit re-arms autosave after a give-up
    if (this.dirty.size > 0 && !this.inFlight) this.schedule(this.host.delay ?? 1200);
    this.emit();
  }

  /** Persist everything pending now (Save / before Submit / No Plan / unmount). Resolves when nothing is pending; rejects with the failure if a save fails. */
  async flush(): Promise<void> {
    this.clear();
    while (!this.disposed) {
      if (this.inFlight) { await this.inFlight; continue; }
      if (this.dirty.size === 0) return;
      await this.run();
      if (this.failed) throw this.error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private run(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.dirty.size === 0) return Promise.resolve();
    const generation = this.generation;
    const sent = new Map(this.dirty); // key → revision being acknowledged by this request
    const snapshot = { ...this.values };
    for (const k of sent.keys()) this.sending.add(k);
    const operation = (async () => {
      try {
        await this.host.persist([...sent.keys()], snapshot);
        if (generation !== this.generation) return;
        for (const [k, rev] of sent) {
          this.persisted = { ...this.persisted, [k]: snapshot[k]! };
          if (this.dirty.get(k) === rev) this.dirty.delete(k); // a newer edit (higher revision) stays pending
        }
        this.attempts = 0;
        this.failed = false;
        this.error = null;
      } catch (err) {
        if (generation !== this.generation) return;
        this.failed = true;
        this.error = err;
        this.attempts += 1;
      } finally {
        if (generation === this.generation) {
          for (const k of sent.keys()) this.sending.delete(k);
          this.inFlight = null;
        }
      }
      if (generation !== this.generation || this.disposed) return;
      if (this.failed) {
        if (this.attempts <= (this.host.maxRetries ?? 3) && (this.host.isTransient ?? defaultTransient)(this.error)) this.schedule((this.host.backoff ?? defaultBackoff)(this.attempts));
      } else if (this.dirty.size > 0) {
        this.schedule(this.host.delay ?? 1200); // edits made while saving → one trailing save with their latest values
      }
    })();
    this.inFlight = operation;
    this.emit();
    void operation.then(() => this.emit());
    return operation;
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    this.clear();
    const set = this.host.setTimer ?? ((fn, d) => setTimeout(fn, d));
    this.timer = set(() => { this.timer = null; void this.run(); }, ms);
  }

  private clear(): void {
    if (this.timer == null) return;
    (this.host.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private emit(): void {
    if (!this.disposed) this.host.onState?.(this.state);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Save failed";
}
