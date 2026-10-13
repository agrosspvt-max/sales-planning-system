import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { latestReceiptAsOfByDealer } from "./last-payment.server";
import { ledgerPoints, selectLatest } from "./dealer-last-payment";

type ReadDb = Pick<Prisma.TransactionClient, "dealerPaymentReceipt" | "dealerLastPayment" | "$queryRaw" | "lastPaymentReceipt">;

/**
 * The Last Payment Report's value for each dealer as of `today` ("YYYY-MM-DD"): READ ONLY (a report read never writes).
 *   1. The dealer's persistent latest payment (DealerLastPayment) — independent of which imports are currently active.
 *   2. Unless the accepted ledger holds a receipt dated after it that is now eligible (a future-dated receipt whose day has arrived): then the same shared selector
 *      is applied to the ledger. A stored newer date is never lost.
 *   3. A dealer with no persistent state yet (before the backfill) falls back to the previous source (active imports + legacy snapshots), unchanged.
 * Historical month-end consumers (Recovery Planning) keep calling `latestReceiptAsOfByDealer` directly with their own as-of date.
 */
export async function loadEffectiveLastPayments(dealerIds: string[], today: string, db: ReadDb = prisma): Promise<Map<string, { date: string; amount: number }>> {
  const out = new Map<string, { date: string; amount: number }>();
  if (dealerIds.length === 0) return out;
  const stored = await db.dealerLastPayment.findMany({ where: { dealerId: { in: dealerIds } }, select: { dealerId: true, paymentDate: true, amount: true } });
  const have = new Map(stored.map((s) => [s.dealerId, { date: s.paymentDate.toISOString().slice(0, 10), amount: Number(s.amount) }]));
  const stale = new Set<string>();
  if (stored.length) {
    const oldest = stored.reduce((min, s) => (s.paymentDate < min ? s.paymentDate : min), stored[0]!.paymentDate);
    const newer = await db.dealerPaymentReceipt.findMany({ where: { dealerId: { in: [...have.keys()] }, receiptDate: { gt: oldest, lte: new Date(`${today}T00:00:00Z`) } }, select: { dealerId: true, receiptDate: true } });
    for (const n of newer) if (n.receiptDate.toISOString().slice(0, 10) > have.get(n.dealerId)!.date) stale.add(n.dealerId);
  }
  if (stale.size) {
    const rows = await db.dealerPaymentReceipt.findMany({ where: { dealerId: { in: [...stale] } }, select: { dealerId: true, receiptDate: true, amount: true, sourceKind: true } });
    const byDealer = new Map<string, typeof rows>();
    for (const r of rows) byDealer.set(r.dealerId, [...(byDealer.get(r.dealerId) ?? []), r]);
    for (const id of stale) { const best = selectLatest(ledgerPoints(byDealer.get(id) ?? []), today); if (best) have.set(id, { date: best.date, amount: best.amount }); }
  }
  for (const [id, v] of have) out.set(id, v);
  const missing = dealerIds.filter((id) => !have.has(id));
  if (missing.length) {
    // No latest-payment summary yet. The permanent ledger comes FIRST (it can hold a receipt that was future-dated when it was accepted and is eligible now, and it
    // outlives any import); the previous sources (active imports + legacy snapshots) only fill in what the ledger cannot say — the newer of the two wins.
    const rows = await db.dealerPaymentReceipt.findMany({ where: { dealerId: { in: missing } }, select: { dealerId: true, receiptDate: true, amount: true, sourceKind: true } });
    const byDealer = new Map<string, typeof rows>();
    for (const r of rows) byDealer.set(r.dealerId, [...(byDealer.get(r.dealerId) ?? []), r]);
    const fromLedger = new Map<string, { date: string; amount: number }>();
    for (const [id, list] of byDealer) { const best = selectLatest(ledgerPoints(list), today); if (best) fromLedger.set(id, { date: best.date, amount: best.amount }); }
    const legacy = await latestReceiptAsOfByDealer(missing, new Date(`${today}T00:00:00.000Z`), db);
    for (const id of missing) {
      const l = fromLedger.get(id), old = legacy.get(id);
      const older = old?.date ? { date: old.date, amount: old.amount ?? 0 } : null;
      const pick = l && older ? (older.date > l.date ? older : l) : l ?? older;
      if (pick) out.set(id, pick);
    }
  }
  return out;
}
