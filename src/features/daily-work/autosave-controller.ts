/**
 * Framework-agnostic autosave engine for one Daily Work section. Extracted from the React hook so the
 * concurrency rules can be unit-tested without a DOM.
 *
 * GUARANTEES (the stability contract):
 *  - At most ONE save is in flight at a time. A change while a save runs never starts a second concurrent
 *    save; it marks the draft dirty and a single trailing save runs after the current one completes.
 *  - Latest state wins: `save()` always serializes the newest snapshot (the host passes the current payload),
 *    and a save is skipped when the current key already equals the last-persisted key.
 *  - Hydration is not an edit: `hydrate(serverKey)` sets the persisted baseline so loading server data never
 *    triggers a save.
 *  - A FAILED save never loops. Transient failures retry with bounded exponential backoff up to `maxRetries`,
 *    then stop (the draft stays dirty; the next genuine edit re-arms autosave). A 409 conflict stops
 *    immediately and calls `onConflict` (the host reloads the current batch) — the stale payload is never
 *    re-sent. This is the fix for the retry-storm that exhausted the DB pool.
 *  - When `enabled` is false (finalized/report view) no save is scheduled or run.
 */
export interface AutosaveHost {
  save: () => Promise<void>;
  onState?: (s: AutosaveState) => void;
  onConflict?: () => void;
  isConflict?: (err: unknown) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  delay?: number;
  maxRetries?: number;
  backoff?: (attempt: number) => number;
}

export interface AutosaveState {
  saving: boolean;
  savedAt: number | null;
  failed: boolean;
}

type RunResult = "SKIPPED" | "SAVED" | "FAILED";

const defaultConflict = (err: unknown): boolean => (err as { status?: number } | null)?.status === 409;
const defaultBackoff = (attempt: number): number => Math.min(8000, 2000 * 2 ** (attempt - 1)); // 2s, 4s, 8s

export class AutosaveController {
  private readonly host: AutosaveHost;
  private readonly delay: number;
  private readonly maxRetries: number;
  private savedKey: string | null = null; // last snapshot known persisted (null = not hydrated)
  private currentKey: string | null = null;
  private enabled = false;
  private inFlight: Promise<RunResult> | null = null;
  private attempts = 0;
  private timer: unknown = null;
  private savedAt: number | null = null;
  private disposed = false;

  constructor(host: AutosaveHost) {
    this.host = host;
    this.delay = host.delay ?? 1000;
    this.maxRetries = host.maxRetries ?? 3;
  }

  private now(): number { return (this.host.now ?? Date.now)(); }
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
  private emit(saving: boolean, failed: boolean): void {
    if (this.disposed) return; // a flush-on-unmount save may still complete server-side; just skip UI updates
    this.host.onState?.({ saving, savedAt: this.savedAt, failed });
  }

  /** The server draft has seeded local state; mark it persisted so seeding never saves. */
  hydrate(serverKey: string): void {
    this.savedKey = serverKey;
    this.attempts = 0;
    this.clear();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  /** Record the section's current payload key (a genuine user edit when it differs from the baseline). */
  update(key: string): void {
    this.currentKey = key;
    if (!this.enabled || this.savedKey === null || key === this.savedKey) return;
    this.attempts = 0; // a fresh edit re-arms autosave even after a prior give-up
    this.schedule(this.delay);
  }

  private run(): Promise<RunResult> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed || !this.enabled) return Promise.resolve("SKIPPED");
    if (this.savedKey === null || this.currentKey === null || this.currentKey === this.savedKey) return Promise.resolve("SKIPPED");
    const target = this.currentKey;
    const operation = this.performSave(target);
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    });
    return operation;
  }

  private async performSave(target: string): Promise<RunResult> {
    this.emit(true, false);
    try {
      await this.host.save();
    } catch (err) {
      this.emit(false, true);
      const conflict = (this.host.isConflict ?? defaultConflict)(err);
      if (conflict) {
        // Stale/frozen batch: never re-send the stale payload. Hand off to the host to reload + reconcile.
        this.attempts = 0;
        this.host.onConflict?.();
        return "FAILED";
      }
      // Transient/other failure: bounded backoff, then stop (draft stays dirty until the next edit).
      this.attempts += 1;
      if (this.enabled && this.attempts <= this.maxRetries) {
        this.schedule((this.host.backoff ?? defaultBackoff)(this.attempts));
      }
      return "FAILED";
    }
    // Success.
    this.savedKey = target;
    this.attempts = 0;
    this.savedAt = this.now();
    this.emit(false, false);
    // A genuinely newer edit landed while saving → one trailing save with the latest snapshot.
    if (this.enabled && this.currentKey !== this.savedKey) this.schedule(this.delay);
    return "SAVED";
  }

  /** Persist immediately if dirty (manual Save Draft / flush on unmount). */
  async flush(): Promise<void> {
    this.clear();
    while (!this.disposed && this.enabled && this.savedKey !== null && this.currentKey !== this.savedKey) {
      const result = await this.run();
      this.clear();
      if (result !== "SAVED") return;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}
