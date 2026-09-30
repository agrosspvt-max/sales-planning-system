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
 *   - lastReceipt : the LATEST Receipt voucher (by date) and THAT SAME row's credit amount — the new
 *     "Last Payment" value. Only Receipt vouchers are considered; CN / SR / Journal / Invoice never count.
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
  /** The Credit Amount from THAT SAME latest Receipt row (null when there is no dated Receipt). */
  lastReceiptAmount: number | null;
}

/**
 * Aggregate classified Day Book rows by dealer. Deterministic: when two Receipts share the exact latest date,
 * the FIRST one encountered wins (strict `>` comparison), so a stable input order yields a stable result.
 */
export function aggregateDaybookByDealer(rows: Iterable<ClassifiedDaybookRow>): Map<string, DealerDaybookAgg> {
  const out = new Map<string, DealerDaybookAgg>();
  for (const row of rows) {
    if (!row.isReceipt && !row.isSrCr) continue; // other voucher types contribute to nothing here
    const acc = out.get(row.dealerId) ?? { receipt: 0, srCr: 0, lastReceiptDate: null, lastReceiptAmount: null };
    if (row.isSrCr) acc.srCr += row.creditAmount;
    if (row.isReceipt) {
      acc.receipt += row.creditAmount;
      // "Last Payment" = the latest Receipt row; its date AND amount come from the SAME row.
      if (row.date != null && (acc.lastReceiptDate == null || row.date.getTime() > acc.lastReceiptDate.getTime())) {
        acc.lastReceiptDate = row.date;
        acc.lastReceiptAmount = row.creditAmount;
      }
    }
    out.set(row.dealerId, acc);
  }
  return out;
}
