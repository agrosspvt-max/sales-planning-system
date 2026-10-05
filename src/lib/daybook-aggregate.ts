/**
 * Day Book per-dealer aggregation (PURE — no DB, no Excel, no matching).
 *
 * The existing Day Book parser (`daybook-parser.ts`) classifies each voucher and resolves its dealer; this
 * helper only AGGREGATES already-classified/resolved rows. It reuses the existing categorisation (Receipt vs
 * SR/CR) rather than re-deriving it — the caller passes the booleans the parser's classifiers produced — so
 * there is no second parser and no duplicated categorisation logic here.
 *
 * It computes, per dealer:
 *   - receipt : Σ Receipt credit  (the existing "Live Recovery" source — unchanged),
 *   - srCr    : Σ SR/CR credit     (the existing "SR/CR" source — unchanged),
 *   - lastReceipt : the LATEST Receipt date and the SUM of every Receipt voucher's credit on that same date — the
 *     "Last Payment" value (several receipts on one day are one payment day; older dates never contribute).
 *     Only Receipt vouchers are considered; CN / SR / Journal / Invoice never count.
 *     A receipt with no date can contribute to the receipt SUM but can never be the "latest" (there is no
 *     date to show), so a dealer whose only receipts are undated has lastReceiptDate = null.
 */

export interface ClassifiedDaybookRow {
  dealerId: string;
  isReceipt: boolean;
  isSrCr: boolean;
  date: Date | null;
  creditAmount: number;
}

export interface DealerDaybookAgg {
  receipt: number;
  srCr: number;
  /** The latest Receipt voucher's date (null when the dealer has no dated Receipt). */
  lastReceiptDate: Date | null;
  /** The SUM of the Receipt credits dated on lastReceiptDate (null when there is no dated Receipt). */
  lastReceiptAmount: number | null;
}

/**
 * Aggregate classified Day Book rows by dealer. Deterministic and order-independent: the latest date is the
 * newest dated Receipt, and the amount is the sum of that calendar day's Receipts.
 */
export function aggregateDaybookByDealer(rows: Iterable<ClassifiedDaybookRow>): Map<string, DealerDaybookAgg> {
  const out = new Map<string, DealerDaybookAgg>();
  const perDay = new Map<string, Map<string, number>>(); // dealerId → calendar day → Σ Receipt credit
  const day = (d: Date) => d.toISOString().slice(0, 10);
  for (const row of rows) {
    if (!row.isReceipt && !row.isSrCr) continue; // other voucher types contribute to nothing here
    const acc = out.get(row.dealerId) ?? { receipt: 0, srCr: 0, lastReceiptDate: null, lastReceiptAmount: null };
    if (row.isSrCr) acc.srCr += row.creditAmount;
    if (row.isReceipt) {
      acc.receipt += row.creditAmount;
      // "Last Payment" = the latest dated Receipt; its amount is totalled over every Receipt on that same day.
      if (row.date != null) {
        const days = perDay.get(row.dealerId) ?? new Map<string, number>();
        days.set(day(row.date), (days.get(day(row.date)) ?? 0) + row.creditAmount);
        perDay.set(row.dealerId, days);
        if (acc.lastReceiptDate == null || row.date.getTime() > acc.lastReceiptDate.getTime()) acc.lastReceiptDate = row.date;
      }
    }
    out.set(row.dealerId, acc);
  }
  for (const [dealerId, acc] of out) {
    if (acc.lastReceiptDate) acc.lastReceiptAmount = Math.round(((perDay.get(dealerId)?.get(day(acc.lastReceiptDate)) ?? 0) + Number.EPSILON) * 100) / 100;
  }
  return out;
}
