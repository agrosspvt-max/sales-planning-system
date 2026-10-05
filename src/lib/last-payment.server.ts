import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { latestReceiptAsOf, type ReceiptPoint } from "./last-payment";

type ReadClient = Pick<Prisma.TransactionClient, "$queryRaw" | "lastPaymentReceipt">;
/** Batched, informational sources only: stored per-plan pairs (tagged "snapshot") + every individual receipt of the
 * active imports. The selector sums the individual receipts on the winning date; the snapshot is the fallback only. */
export async function loadLastPaymentPoints(
  dealerIds: string[],
  throughDate: Date,
  db: ReadClient = prisma,
) {
  const points = new Map<string, ReceiptPoint[]>();
  if (!dealerIds.length) return points;
  const legacy = await db.$queryRaw<{ dealerId: string; date: string; amount: string | null }[]>`
    SELECT "dealerId", "lastReceiptDate"::text AS "date", "lastReceiptAmount"::text AS "amount"
    FROM "RecoveryPlanDealer" WHERE "dealerId" = ANY(${dealerIds}) AND "lastReceiptDate" IS NOT NULL`;
  for (const r of legacy) {
    const list = points.get(r.dealerId) ?? [];
    // A stored per-plan summary of receipts — tagged so the selector never adds it to the individual receipts below.
    list.push({ date: r.date.slice(0, 10), amount: r.amount == null ? 0 : Number(r.amount), kind: "snapshot" });
    points.set(r.dealerId, list);
  }
  const history = await db.lastPaymentReceipt.findMany({
    where: {
      dealerId: { in: dealerIds },
      receiptDate: { lte: throughDate },
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
  throughDate: Date,
  db: ReadClient = prisma,
) {
  const points = await loadLastPaymentPoints(dealerIds, throughDate, db);
  const out = new Map<string, { date: string | null; amount: number | null }>();
  for (const [id, receipts] of points) {
    const best = latestReceiptAsOf(receipts, throughDate.toISOString().slice(0, 10));
    if (best) out.set(id, best);
  }
  return out;
}
