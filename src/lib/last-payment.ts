/**
 * "Last Payment" carry-forward selection (pure). The Recovery Planning Month View shows, for each dealer, the
 * latest Day Book RECEIPT known AS OF the Recovery Plan's cutoff date — carried forward across months until a
 * newer Receipt supersedes it. This module only SELECTS among already-identified receipt points (date + the
 * amount from that same receipt row); it does not parse Day Book, classify vouchers, or match dealers.
 */

export interface ReceiptPoint {
  /** Receipt date as "YYYY-MM-DD" (lexicographically comparable). */
  date: string;
  /** Credit Amount from THAT SAME receipt row. */
  amount: number;
}

/**
 * The latest receipt on or before `cutoff` (both "YYYY-MM-DD").
 *   - Receipts AFTER the cutoff are ignored → a later Day Book never changes an earlier month.
 *   - The newest qualifying receipt wins; ties on date keep the first encountered (deterministic for stable input).
 *   - Date and amount are always returned together from the same point.
 * Returns null when the dealer has no receipt on or before the cutoff (→ the existing empty state).
 */
export function latestReceiptAsOf(points: readonly ReceiptPoint[], cutoff: string): ReceiptPoint | null {
  let best: ReceiptPoint | null = null;
  for (const p of points) {
    if (!p || !p.date || p.date > cutoff) continue; // ignore receipts dated after the plan cutoff
    if (best === null || p.date > best.date) best = p;
  }
  return best;
}
