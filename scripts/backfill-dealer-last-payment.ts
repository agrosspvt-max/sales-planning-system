/**
 * Initialize the permanent Last Payment state (DealerPaymentReceipt ledger + DealerLastPayment) from the EXISTING payment sources.
 *
 *   npx tsx scripts/backfill-dealer-last-payment.ts                 # PREVIEW (default): does the work slice by slice inside rolled-back transactions and prints the review report
 *   npx tsx scripts/backfill-dealer-last-payment.ts --apply         # writes (local database)
 *   BACKFILL_CONFIRM=owner-signed-off npx tsx scripts/backfill-dealer-last-payment.ts --apply   # required for any non-local database
 *
 * Sources: receipts of ACTIVE imports; receipts of REGULAR files a normal replacement deactivated for dealers the replacement never mentioned (newest file per dealer; never an older
 * version of a dealer a current file covers; never a Historical row); legacy per-plan snapshots as a fallback for dates without individual receipts. Billing-exception snapshots
 * are NOT a source. Writes only the ledger and the latest-payment table (no Recovery value, exception, task or assignment). Restartable and idempotent: it runs in slices of dealers,
 * each its own short transaction serialized with Day Book uploads by the receipt-store advisory lock; re-running adds nothing.
 * The preview shows: dealers examined / currently missing permanent records, receipts and summaries that would be added, before → after per dealer, and conflicting sources.
 * Connection: DIRECT_URL, else DATABASE_URL. Credentials are never printed.
 */
import { PrismaClient } from "@prisma/client";
import { backfillDealerLastPayments, legacySourceDealerIds, type BackfillStats } from "../src/lib/dealer-last-payment";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
class DryRunRollback extends Error {}
const SLICE = 100;

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DIRECT_URL or DATABASE_URL.");
  const host = new URL(url).hostname;
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  if (apply && !local && process.env.BACKFILL_CONFIRM !== "owner-signed-off") throw new Error(`Refusing to --apply to a non-local database (${host}) without BACKFILL_CONFIRM=owner-signed-off.`);
  const at = today();
  console.log(`${apply ? "APPLY" : "PREVIEW (every slice rolled back)"} · database host: ${host} · business date: ${at}`);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const universe = await legacySourceDealerIds(prisma);
    const total: BackfillStats = { dealersExamined: 0, dealersMissingBefore: 0, receiptsAccepted: 0, receiptsSkipped: 0, snapshotsAdded: 0, summariesWritten: 0, supersededAccepted: 0, compared: 0, identical: 0, different: 0, differences: [], changes: [], conflicts: [] };
    for (let i = 0; i < universe.length; i += SLICE) {
      const slice = universe.slice(i, i + SLICE);
      let stats: BackfillStats | undefined;
      try {
        stats = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(79241362)`; // the receipt-store lock Day Book uploads take
          const result = await backfillDealerLastPayments(tx, at, { dealerIds: slice });
          if (!apply) { stats = result; throw new DryRunRollback(); }
          return result;
        }, { timeout: 120_000, maxWait: 30_000 });
      } catch (error) {
        if (!(error instanceof DryRunRollback)) throw error;
      }
      if (!stats) continue;
      for (const k of ["dealersExamined", "dealersMissingBefore", "receiptsAccepted", "receiptsSkipped", "snapshotsAdded", "summariesWritten", "supersededAccepted", "compared", "identical", "different"] as const) total[k] += stats[k];
      total.changes.push(...stats.changes); total.conflicts.push(...stats.conflicts); total.differences.push(...stats.differences);
      console.log(`slice ${i / SLICE + 1}/${Math.ceil(universe.length / SLICE)} · ${slice.length} dealers · ${apply ? "committed" : "rolled back"}`);
    }
    const names = new Map((await prisma.dealer.findMany({ where: { id: { in: [...new Set([...total.changes.map((c) => c.dealerId), ...total.conflicts.map((c) => c.dealerId)])] } }, select: { id: true, name: true, status: true } })).map((d) => [d.id, `${d.name} (${d.status})`]));
    const summary = { dealersWithAnySource: universe.length, ...Object.fromEntries((["dealersExamined", "dealersMissingBefore", "receiptsAccepted", "receiptsSkipped", "snapshotsAdded", "summariesWritten", "supersededAccepted", "identical", "different"] as const).map((k) => [k, total[k]])), conflicts: total.conflicts.length, changedDealers: total.changes.length };
    console.log(JSON.stringify(summary, null, 2));
    console.log("BEFORE → AFTER (dealers whose latest payment is created or changes):");
    for (const c of total.changes) console.log(`  ${names.get(c.dealerId) ?? c.dealerId}: ${c.before ? `${c.before.date} ₹${c.before.amount}` : "—"}  →  ${c.after ? `${c.after.date} ₹${c.after.amount}` : "—"}`);
    console.log(total.conflicts.length ? "CONFLICTING SOURCES (review; nothing differs because of them):" : "No conflicting sources.");
    for (const c of total.conflicts) console.log(`  ${names.get(c.dealerId) ?? c.dealerId} · ${c.kind} · ${c.detail}`);
    console.log(apply ? "Applied." : "Preview finished; nothing was written.");
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
