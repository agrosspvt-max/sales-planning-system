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

type HistoryClient = ReadClient & Pick<Prisma.TransactionClient, "dealer">;

/** Individual, accepted receipts survive import replacement in the permanent ledger. Limit per dealer,
 * never per plan, and never present a saved daily/monthly summary as an individual receipt. */
export async function loadIndividualReceiptHistory(dealerIds: string[], throughDate: Date, db: Pick<Prisma.TransactionClient, "dealer"> = prisma) {
  if (!dealerIds.length) return new Map<string, ReceiptPoint[]>();
  const dealers = await db.dealer.findMany({
    where: { id: { in: dealerIds } },
    select: {
      id: true,
      paymentReceipts: {
        where: { receiptDate: { lte: throughDate }, amount: { gt: 0 }, sourceKind: { in: ["REGULAR", "HISTORICAL"] } },
        orderBy: [{ receiptDate: "desc" }, { createdAt: "desc" }, { sourceOrder: "desc" }, { id: "desc" }],
        take: 5,
        select: { receiptDate: true, amount: true },
      },
    },
  });
  return new Map(dealers.map(dealer => [dealer.id, dealer.paymentReceipts.map(receipt => ({
    date: receipt.receiptDate.toISOString().slice(0, 10), amount: Number(receipt.amount),
  }))]));
}

/** Keep the existing Last Payment column unchanged; the popup reads individual receipts from the
 * permanent ledger, independently of active/inactive upload batches and legacy plan snapshots. */
export async function recoveryPaymentDetailsByDealer(dealerIds: string[], throughDate: Date, db: HistoryClient = prisma) {
  const [points, history] = await Promise.all([
    loadLastPaymentPoints(dealerIds, throughDate, db),
    loadIndividualReceiptHistory(dealerIds, throughDate, db),
  ]);
  const cutoff = throughDate.toISOString().slice(0, 10);
  return new Map(dealerIds.map(id => [id, {
    latest: latestReceiptAsOf(points.get(id) ?? [], cutoff),
    payments: history.get(id) ?? [],
  }]));
}
