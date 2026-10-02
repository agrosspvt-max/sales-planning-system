/**
 * "Last Payment" carry-forward selection (pure). The Recovery Planning Month View shows, for each dealer, the
 * latest Day Book RECEIPT on or before its explicit calendar month-end — carried forward across months until a
 * newer Receipt supersedes it. This module only SELECTS among already-identified receipt points (date + the
 * amount from that same receipt row); it does not parse Day Book, classify vouchers, or match dealers.
 */
import { identity, type MonthIdentity } from "./season-calendar";

/** No inference from names, order, season year or the separate RecoveryPlan.cutoffDate. */
export function lastPaymentMonthEnd(month: MonthIdentity): Date | null {
  const calendar = identity(month);
  return calendar ? new Date(Date.UTC(calendar.year, calendar.month, 0)) : null;
}

export interface ReceiptPoint {
  /** Receipt date as "YYYY-MM-DD" (lexicographically comparable). */
  date: string;
  /** Credit Amount from THAT SAME receipt row. */
  amount: number;
}

/**
 * The latest receipt on or before `cutoff` (both "YYYY-MM-DD").
 *   - Receipts AFTER the supplied as-of boundary are ignored.
 *   - The newest qualifying receipt wins; ties on date keep the first encountered (deterministic for stable input).
 *   - Date and amount are always returned together from the same point.
 * Returns null when the dealer has no receipt on or before the cutoff (→ the existing empty state).
 */
export function latestReceiptAsOf(points: readonly ReceiptPoint[], cutoff: string): ReceiptPoint | null {
  let best: ReceiptPoint | null = null;
  for (const p of points) {
    if (!p || !p.date || p.date > cutoff) continue;
    if (best === null || p.date > best.date) best = p;
  }
  return best;
}
