import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { latestReceiptAsOf, type ReceiptPoint } from "./last-payment";

type ReadClient = Pick<Prisma.TransactionClient, "$queryRaw" | "lastPaymentReceipt">;
/** Batched, informational sources only. Legacy regular pairs retain precedence on equal dates;
 * individual history ties use stable import/source order, matching the selector's first-on-tie rule. */
export async function loadLastPaymentPoints(
  dealerIds: string[],
  cutoff: Date,
  db: ReadClient = prisma,
) {
  const points = new Map<string, ReceiptPoint[]>();
  if (!dealerIds.length) return points;
  const legacy = await db.$queryRaw<{ dealerId: string; date: string; amount: string | null }[]>`
    SELECT "dealerId", "lastReceiptDate"::text AS "date", "lastReceiptAmount"::text AS "amount"
    FROM "RecoveryPlanDealer" WHERE "dealerId" = ANY(${dealerIds}) AND "lastReceiptDate" IS NOT NULL`;
  for (const r of legacy) {
    const list = points.get(r.dealerId) ?? [];
    list.push({ date: r.date.slice(0, 10), amount: r.amount == null ? 0 : Number(r.amount) });
    points.set(r.dealerId, list);
  }
  const history = await db.lastPaymentReceipt.findMany({
    where: {
      dealerId: { in: dealerIds },
      receiptDate: { lte: cutoff },
      import: { isActive: true },
    },
    orderBy: [{ import: { createdAt: "asc" } }, { sourceOrder: "asc" }, { id: "asc" }],
    select: { dealerId: true, receiptDate: true, creditAmount: true },
  });
  for (const r of history) {
    const list = points.get(r.dealerId) ?? [];
    list.push({ date: r.receiptDate.toISOString().slice(0, 10), amount: Number(r.creditAmount) });
    points.set(r.dealerId, list);
  }
  return points;
}
export async function latestReceiptAsOfByDealer(
  dealerIds: string[],
  cutoff: Date,
  db: ReadClient = prisma,
) {
  const points = await loadLastPaymentPoints(dealerIds, cutoff, db);
  const out = new Map<string, { date: string | null; amount: number | null }>();
  for (const [id, receipts] of points) {
    const best = latestReceiptAsOf(receipts, cutoff.toISOString().slice(0, 10));
    if (best) out.set(id, best);
  }
  return out;
}
