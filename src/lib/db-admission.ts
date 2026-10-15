import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError } from "./api-error";

export const DATABASE_BUSY_MESSAGE = "The database is busy. Please try again shortly.";

/** Bound work BEFORE Prisma checks out a connection. Never release a running operation early. */
export class DatabaseAdmission {
  private active = 0;
  private readonly waiting: Array<{ start: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(readonly limit: number, readonly maxQueued = 100, readonly queueWaitMs = 10_000) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Database concurrency must be a positive integer");
  }

  get stats() { return { active: this.active, queued: this.waiting.length, limit: this.limit }; }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await operation(); }
    finally { this.release(); }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) { this.active++; return Promise.resolve(); }
    if (this.waiting.length >= this.maxQueued) return Promise.reject(new ApiError(503, DATABASE_BUSY_MESSAGE));
    return new Promise((resolve, reject) => {
      const entry = { start: resolve, reject, timer: setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) { this.waiting.splice(index, 1); reject(new ApiError(503, DATABASE_BUSY_MESSAGE)); }
      }, this.queueWaitMs) };
      this.waiting.push(entry);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) { clearTimeout(next.timer); next.start(); }
    else this.active--;
  }
}

export interface DatabaseRuntime {
  admission: DatabaseAdmission;
  transaction: AsyncLocalStorage<boolean>;
}

/** Keep explicit pool settings. Give CPU-independent defaults to this app's pooled PostgreSQL client. */
export function databaseRuntimeOptions(url: string, requestedConcurrency?: string) {
  const parsed = new URL(url);
  const configured = parsed.searchParams.get("connection_limit");
  const poolSize = configured == null ? 8 : Number(configured);
  if (!Number.isInteger(poolSize) || poolSize < 1) throw new Error("Invalid PostgreSQL connection_limit");
  if (configured == null) parsed.searchParams.set("connection_limit", String(poolSize));
  const available = Math.max(1, poolSize - 2);
  const limit = requestedConcurrency == null ? Math.min(6, available) : Number(requestedConcurrency);
  if (!Number.isInteger(limit) || limit < 1 || limit > available) throw new Error("DB_MAX_CONCURRENT_OPERATIONS must leave two pool connections free (or use 1 for a small pool)");
  return { url: parsed.toString(), limit, poolSize };
}

/**
 * One slot for an entire transaction, not a slot for each of its statements. The async context lets
 * transaction queries proceed even when every admission slot is held by another transaction.
 * Batch transactions retain the original lazy PrismaPromises (do not await/map their inputs).
 */
export function admitPrismaClient<T extends { $extends: (...args: any[]) => any }>(client: T, runtime: DatabaseRuntime): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  const extended = client.$extends({
    name: "bounded-database-work",
    query: {
      async $allOperations({ args, query }: { args: unknown; query: (args: unknown) => Promise<unknown> }) {
        return runtime.transaction.getStore() ? query(args) : runtime.admission.run(() => query(args));
      },
    },
  });
  return new Proxy(extended, {
    get(target, key, receiver) {
      if (key !== "$transaction") return Reflect.get(target, key, receiver);
      return (input: unknown, options?: unknown) => runtime.admission.run(() =>
        runtime.transaction.run(true, () => target.$transaction(input, options)),
      );
    },
  }) as T;
}
