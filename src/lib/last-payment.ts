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
  /** Credit Amount of this receipt (for a "snapshot": of the stored per-plan Last Payment, see `kind`). */
  amount: number;
  /**
   * "snapshot" marks a stored per-plan Last Payment pair (RecoveryPlanDealer.lastReceipt*). It SUMMARISES receipts
   * that are normally also present as individual receipts, so it must never be added to them. Anything else is an
   * individual receipt.
   */
  kind?: "snapshot";
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The dealer's Last Payment as of `cutoff` (both "YYYY-MM-DD").
 *   - Receipts AFTER the supplied as-of boundary are ignored.
 *   - DATE: the newest qualifying date wins (unchanged).
 *   - AMOUNT: the SUM of every individual receipt on that selected date — several receipts on the same day are one
 *     payment day. Receipts on any other (older) date never contribute, however large they are.
 *   - A stored snapshot on that date is only a summary of those receipts, so it is used only when no individual
 *     receipt exists on the date (then, as before, the first encountered snapshot is used — never summed).
 * Returns null when the dealer has no receipt on or before the cutoff (→ the existing empty state).
 */
export function latestReceiptAsOf(points: readonly ReceiptPoint[], cutoff: string): ReceiptPoint | null {
  let latest: string | null = null;
  for (const p of points) {
    if (!p || !p.date || p.date > cutoff) continue;
    if (latest === null || p.date > latest) latest = p.date;
  }
  if (latest === null) return null;
  const onDate = points.filter((p) => p && p.date === latest);
  const receipts = onDate.filter((p) => p.kind !== "snapshot");
  if (receipts.length) return { date: latest, amount: round2(receipts.reduce((sum, p) => sum + p.amount, 0)) };
  return { date: latest, amount: onDate[0].amount };
}
