/**
 * Explicit, idempotent repair: put VALID receipts of REGULAR Day Book files that a normal replacement already deactivated into the permanent payment ledger — for the
 * dealers the replacement never mentioned (so those dealers lost their usable Last Payment source before permanent storage / its runtime existed).
 *
 *   npx tsx scripts/repair-superseded-receipts.ts --receipt cmv6boe51000ll506xsc4xcuo            # DRY RUN (default): does the work in a transaction, prints before/after, ROLLS BACK
 *   npx tsx scripts/repair-superseded-receipts.ts --all-eligible                                  # dry run over every eligible receipt (the initialization plan)
 *   BACKFILL_CONFIRM=owner-signed-off npx tsx scripts/repair-superseded-receipts.ts --receipt <id> --apply   # required for any non-local database
 *
 * Eligibility (see selectSupersededReceipts): REGULAR files only; per month the NEWEST file that mentions the dealer; the dealer is mentioned by NO active file of that month.
 * A named receipt that is not eligible is reported with the reason and never written. Billing-exception snapshots are not evidence and are only displayed.
 * Idempotent (ledger identity), serialized with Day Book uploads by the receipt-store advisory lock, never reactivates an import, never touches Recovery values or exceptions.
 * Connection: DIRECT_URL, else DATABASE_URL. Credentials are never printed.
 */
import { PrismaClient } from "@prisma/client";
import { preserveSupersededReceipts } from "../src/lib/dealer-last-payment";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const days = (iso: string, at: string) => Math.round((Date.parse(`${at}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
class DryRunRollback extends Error {}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply"), all = args.includes("--all-eligible");
  const receiptIds = args.flatMap((a, i) => (a === "--receipt" && args[i + 1] ? [args[i + 1]!] : []));
  if (!all && receiptIds.length === 0) throw new Error("Name at least one --receipt <id>, or use --all-eligible.");
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DIRECT_URL or DATABASE_URL.");
  const host = new URL(url).hostname;
  if (apply && !["localhost", "127.0.0.1", "::1"].includes(host) && process.env.BACKFILL_CONFIRM !== "owner-signed-off") throw new Error(`Refusing to --apply to a non-local database (${host}) without BACKFILL_CONFIRM=owner-signed-off.`);
  const at = today();
  console.log(`${apply ? "APPLY" : "DRY RUN (rolled back)"} · database host: ${host} · business date: ${at}`);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(79241362)`; // the receipt-store lock Day Book uploads take
      const plan = await preserveSupersededReceipts(tx, at, { ...(all ? {} : { onlyReceiptIds: receiptIds }), dryRun: true });
      const eligibleIds = new Set(plan.eligible.map((p) => p.receiptId));
      for (const id of receiptIds.filter((r) => !eligibleIds.has(r))) {
        const r = await tx.lastPaymentReceipt.findUnique({ where: { id }, select: { dealerId: true, import: { select: { kind: true, isActive: true, scopeKey: true } } } });
        console.log(`NOT ELIGIBLE ${id}: ${!r ? "no such receipt" : r.import.kind !== "REGULAR" ? "not a REGULAR Day Book file" : r.import.isActive ? "its file is still active" : "a newer file or an active file of the same month speaks for this dealer"} — nothing will be written.`);
      }
      const dealerIds = plan.dealerIds;
      const info = async () => {
        const [dealers, latest, exceptions] = await Promise.all([
          tx.dealer.findMany({ where: { id: { in: dealerIds } }, select: { id: true, name: true, status: true } }),
          tx.dealerLastPayment.findMany({ where: { dealerId: { in: dealerIds } } }),
          tx.billingException.groupBy({ by: ["dealerId"], where: { status: "CURRENT", dealerId: { in: dealerIds } }, _count: { _all: true } }),
        ]);
        return dealerIds.map((id) => { const l = latest.find((x) => x.dealerId === id); const date = l?.paymentDate.toISOString().slice(0, 10) ?? null;
          return { dealerId: id, name: dealers.find((d) => d.id === id)?.name, status: dealers.find((d) => d.id === id)?.status, latestPayment: l ? { date, amount: Number(l.amount) } : null, days: date ? days(date, at) : null, currentExceptions: exceptions.find((e) => e.dealerId === id)?._count._all ?? 0 }; });
      };
      const before = await info();
      console.log("ELIGIBLE RECEIPTS:", JSON.stringify(plan.eligible, null, 2));
      console.log("BEFORE:", JSON.stringify(before, null, 2));
      const done = await preserveSupersededReceipts(tx, at, { ...(all ? {} : { onlyReceiptIds: receiptIds }) });
      console.log(`ledger rows added: ${done.accepted} · already present: ${done.skipped}`);
      const after = await info();
      console.log("AFTER (expected):", JSON.stringify(after, null, 2));
      for (const a of after.filter((x) => x.currentExceptions > 0 && x.days !== null && x.days <= 45)) console.log(`NOTE: ${a.name} will be Open (${a.days} days); its ${a.currentExceptions} Current exception(s) resolve on the next Day Book upload or reconciliation.`);
      if (!apply) throw new DryRunRollback();
    }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    console.log("Dry run finished; nothing was written.");
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
