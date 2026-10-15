/** Process-wide auth single-flight: route bundles/hot reloads share it just like the Prisma client. */
export class AuthUserCache<T> {
  private cached = new Map<string, { at: number; row: T }>();
  private inflight = new Map<string, Promise<T>>();
  private revisions = new Map<string, number>();

  load(id: string, key: string, ttlMs: number, lookup: () => Promise<T>): Promise<T> {
    const cached = this.cached.get(key);
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.row);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const revision = this.revisions.get(id) ?? 0;
    const promise = Promise.resolve().then(lookup).then((row) => {
      // A role/password/deactivation change happened while the query was in flight. Never put its
      // old result back into the cache, or authorize the waiting callers from that stale result.
      if ((this.revisions.get(id) ?? 0) !== revision) return this.load(id, key, ttlMs, lookup);
      if (ttlMs > 0) {
        if (this.cached.size >= 1000) {
          for (const [k, v] of this.cached) if (Date.now() - v.at >= ttlMs) this.cached.delete(k);
          if (this.cached.size >= 1000) this.cached.delete(this.cached.keys().next().value!);
        }
        this.cached.set(key, { at: Date.now(), row });
      }
      return row;
    });
    this.inflight.set(key, promise);
    void promise.finally(() => { if (this.inflight.get(key) === promise) this.inflight.delete(key); }).catch(() => {});
    return promise;
  }

  invalidate(id: string): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    for (const key of this.cached.keys()) if (key.startsWith(`${id}:`)) this.cached.delete(key);
    for (const key of this.inflight.keys()) if (key.startsWith(`${id}:`)) this.inflight.delete(key);
  }
}

const state = globalThis as unknown as { authUserCache?: AuthUserCache<unknown> };
export function sharedAuthUserCache<T>(): AuthUserCache<T> {
  return (state.authUserCache ??= new AuthUserCache<unknown>()) as AuthUserCache<T>;
}
