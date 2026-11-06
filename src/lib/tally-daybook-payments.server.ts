import "server-only";
import type { Prisma } from "@prisma/client";
import { approvedTestPreview } from "@/features/tally/sales-rollout";
import type { ReceiptPoint } from "./last-payment";

type Db = Pick<Prisma.TransactionClient, "tallyDaybookDealerMonth">;
type Coverage = Map<string, { throughDate: string; receipts: ReceiptPoint[] }>;

export async function loadDaybookPaymentCoverage(db: Db, dealerIds: string[], through: string) {
  const byDealer = new Map<string, Coverage>();
  if (!dealerIds.length || !approvedTestPreview()) return byDealer;
  const rows = await db.tallyDaybookDealerMonth.findMany({
    where: { dealerId: { in: dealerIds }, monthKey: { lte: through.slice(0, 7) } },
    select: { dealerId: true, monthKey: true, throughDate: true, receiptDays: true },
  });
  for (const row of rows) {
    const coverage =
      byDealer.get(row.dealerId) ??
      new Map<string, { throughDate: string; receipts: ReceiptPoint[] }>();
    const receipts = Object.entries(row.receiptDays as Record<string, string>)
      .filter(([date]) => date <= through)
      .map(([date, amount]) => ({ date, amount: Number(amount) }));
    coverage.set(row.monthKey, { throughDate: row.throughDate, receipts });
    byDealer.set(row.dealerId, coverage);
  }
  return byDealer;
}

export function combineDaybookPaymentPoints(coverage: Coverage, legacy: ReceiptPoint[]) {
  // A verified Tally period owns these dates for this dealer. Excel and legacy copies
  // within it can include the very same receipts or receipts since corrected in Tally.
  return [
    ...legacy.filter((point) => {
      const source = coverage.get(point.date.slice(0, 7));
      return !source || point.date > source.throughDate;
    }),
    ...[...coverage.values()].flatMap((month) => month.receipts),
  ];
}
