import type { Query } from "@tanstack/react-query";

/**
 * Shared polling / retry rules for React Query (browser only; no new infrastructure).
 *
 *  • A request that failed for a TEMPORARY reason (no HTTP status = network, 5xx, 408, 429) may be retried once by React Query; a refused request
 *    (401 / 403 / 404 / 409 / 422 …) is never retried — it would only fail again and add load.
 *  • A polled query keeps its normal interval while healthy. After failures it backs off exponentially (capped) with ±20 % jitter, so many tabs do
 *    not retry in lock-step against a struggling database, and it KEEPS probing at the capped interval — so it recovers by itself, including a query
 *    whose very first load failed. Window focus and network reconnect also refetch a failed query at once (see queryDefaults).
 *  • Authentication / permission failures stop the poll (the session or access must change first; the api client already handles 401 → sign-in).
 */
export const statusOf = (error: unknown): number | undefined => (error as { status?: number } | null)?.status;
export const isTransientError = (error: unknown): boolean => {
  const status = statusOf(error);
  return status === undefined || status >= 500 || status === 408 || status === 429;
};

/** React Query `retry`: at most one extra attempt, and only for a temporary failure. */
export const retryTransientOnce = (failureCount: number, error: unknown): boolean => failureCount < 1 && isTransientError(error);

export const POLL_BACKOFF_MAX_MS = 5 * 60_000;

/** The next poll delay for `baseMs` given the number of consecutive failed polls (0 = healthy). Pure, for tests. */
export function pollDelay(baseMs: number, consecutiveFailures: number, random: () => number = Math.random): number {
  if (consecutiveFailures <= 0) return baseMs;
  const delay = Math.min(POLL_BACKOFF_MAX_MS, baseMs * 2 ** Math.min(consecutiveFailures, 10));
  return Math.round(delay * (0.8 + 0.4 * random()));
}

/**
 * A `refetchInterval` function: `baseMs` while healthy, capped exponential backoff while failing, `false` (stop) after an authentication or
 * permission failure, and `false` whenever `active` says the data does not need refreshing (a hidden panel, a finished state …).
 */
export function pollingInterval<TData = unknown>(baseMs: number, active: (query: Query<TData, Error, TData, readonly unknown[]>) => boolean = () => true) {
  // Consecutive failures = errors since the last success. Derived from the query's own counters, so it is the same however often React Query
  // asks for the interval (it may ask several times per fetch).
  const errorsAtLastSuccess = new WeakMap<object, number>();
  return (query: Query<TData, Error, TData, readonly unknown[]>): number | false => {
    if (!active(query)) return false;
    const { status, error, errorUpdateCount } = query.state;
    if (status === "error" && (statusOf(error) === 401 || statusOf(error) === 403)) return false;
    if (status !== "error") { errorsAtLastSuccess.set(query, errorUpdateCount); return baseMs; }
    return pollDelay(baseMs, errorUpdateCount - (errorsAtLastSuccess.get(query) ?? 0));
  };
}
