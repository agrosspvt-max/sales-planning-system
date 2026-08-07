import "server-only";

/**
 * Retry a database operation on TRANSIENT connection-level errors only (Neon scale-up, momentary
 * pool/connection unavailability). This never changes query results or security — it just re-attempts
 * the exact same read/write when the server was briefly unreachable. Logic errors, validation errors,
 * constraint violations, etc. are NOT retried (they re-throw immediately).
 *
 *   P1001 Can't reach database server
 *   P1002 Server reached but timed out
 *   P1008 Operation timed out
 *   P1017 Server has closed the connection
 */
const TRANSIENT_CODES = new Set(["P1001", "P1002", "P1008", "P1017"]);

function isTransient(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

export async function withDbRetry<T>(fn: () => Promise<T>, opts: { retries?: number; delayMs?: number } = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? 200;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt === retries) throw e;
      lastError = e;
      // Linear backoff (200ms, 400ms…) — enough for a Neon connection to free up / compute to scale.
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}
