/** Persistent latest payment: receipt identity, update rules (in-memory ledger) and wiring. Real concurrency / Day Book commits: dealer-last-payment.integration.ts (opt-in). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acceptReceipts, acceptableReceipts, assignOccurrences, missingPermanentPayments, selectLatest, selectSupersededReceipts, type PaymentDb, type RetainedImport } from "./dealer-last-payment";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const TODAY = "2026-10-13";
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

/* ---- pure: identity ---- */
const occ = (rows: { dealerId: string; date: string; amount: number; sourceOrder?: number }[]) => assignOccurrences(rows).map((r) => [r.dealerId, r.date, r.amount, r.occurrence].join("|"));
assert.deepEqual(occ([{ dealerId: "a", date: "2026-10-01", amount: 500, sourceOrder: 2 }, { dealerId: "a", date: "2026-10-01", amount: 500, sourceOrder: 1 }, { dealerId: "a", date: "2026-10-01", amount: 700, sourceOrder: 3 }]),
  ["a|2026-10-01|500|1", "a|2026-10-01|500|2", "a|2026-10-01|700|1"], "identical genuine rows of ONE file get distinct occurrences; a different amount is its own receipt");
assert.equal(acceptableReceipts([{ dealerId: "a", date: "2026-10-01", amount: 0 }, { dealerId: "a", date: "bad", amount: 5 }, { dealerId: "", date: "2026-10-01", amount: 5 }, { dealerId: "a", date: "2026-10-01", amount: Number.NaN }, { dealerId: "a", date: "2026-10-01", amount: 5 }]).length, 1);
assert.deepEqual(selectLatest([{ date: "2026-10-01", amount: 100 }, { date: "2026-10-01", amount: 50 }, { date: "2026-09-01", amount: 9999 }], TODAY), { date: "2026-10-01", amount: 150, basis: "RECEIPTS" }, "same-day sum; older dates never contribute");
assert.deepEqual(selectLatest([{ date: "2026-10-01", amount: 150, kind: "snapshot" }, { date: "2026-10-01", amount: 100 }, { date: "2026-10-01", amount: 50 }], TODAY), { date: "2026-10-01", amount: 150, basis: "RECEIPTS" }, "a snapshot is never added to its own receipts");
assert.deepEqual(selectLatest([{ date: "2026-10-01", amount: 150, kind: "snapshot" }], TODAY), { date: "2026-10-01", amount: 150, basis: "LEGACY_SNAPSHOT" });
assert.equal(selectLatest([{ date: "2026-12-01", amount: 5 }], TODAY), null, "future-dated receipts do not qualify today");
assert.equal(selectLatest([{ date: "2026-12-01", amount: 5 }], "2026-12-02")?.amount, 5, "…and qualify once their day arrives");

/* ---- pure: which superseded receipts still speak for a dealer ---- */
{
  const rc = (id: string, dealerId: string, date: string, amount: number, order = 1) => ({ id, dealerId, receiptDate: d(date), creditAmount: amount, sourceOrder: order, voucherNumber: null });
  const file = (id: string, at: string, isActive: boolean, receipts: RetainedImport["receipts"], scopeKey = "m"): RetainedImport => ({ id, scopeKey, isActive, createdAt: new Date(at), receipts });
  const ids = (picks: { receiptId: string }[]) => picks.map((p) => p.receiptId).sort();
  const f1 = file("f1", "2026-10-06T00:00:00Z", false, [rc("a1", "A", "2026-07-01", 120000), rc("b1", "B", "2026-10-01", 30000)]);
  const f2 = file("f2", "2026-10-07T00:00:00Z", false, [rc("b2", "B", "2026-10-02", 40000)]); // corrected file: speaks for B
  const f3 = file("f3", "2026-10-08T00:00:00Z", true, [rc("c3", "C", "2026-10-08", 500)]);
  // audit / repair: A (only in an inactive file) and B (newest inactive file f2 only) qualify; C is covered by an active file; B's OLDER version (b1) is never added
  assert.deepEqual(ids(selectSupersededReceipts([f1, f2, f3])), ["a1", "b2"], "absent dealers: the newest earlier file's receipts only; active dealers and older versions are skipped");
  // a dealer the ACTIVE file also contains is the active file's to speak for
  assert.deepEqual(ids(selectSupersededReceipts([f1, file("f4", "2026-10-09T00:00:00Z", true, [rc("a4", "A", "2026-10-09", 1)])])), ["b1"]);
  // replacement being committed: dealers of the incoming file are skipped, everyone else of THAT month is kept — even from the still-active file
  assert.deepEqual(ids(selectSupersededReceipts([f1, f2, f3], { scopeKey: "m", dealerIds: new Set(["C"]) })), ["a1", "b2"].sort());
  assert.deepEqual(ids(selectSupersededReceipts([f1, f2, f3], { scopeKey: "m", dealerIds: new Set(["A", "B"]) })), ["c3"], "the active file's dealer absent from the replacement is preserved BEFORE it is deactivated");
  assert.deepEqual(selectSupersededReceipts([f1, file("o", "2026-10-06T00:00:00Z", false, [rc("x", "Z", "2026-09-01", 9)], "other-month")], { scopeKey: "m", dealerIds: new Set() }).map((p) => p.dealerId).sort(), ["A", "B"], "another month's files are not this replacement's business");
  assert.deepEqual(selectSupersededReceipts([file("olderActive", "2026-10-01T00:00:00Z", true, [rc("p1", "A", "2026-09-01", 1)]), file("newerInactive", "2026-10-02T00:00:00Z", false, [rc("p2", "A", "2026-09-02", 2)])]), [], "an ACTIVE file that mentions the dealer speaks for it, even when a newer file is inactive");
  assert.deepEqual(selectSupersededReceipts([file("bad", "2026-10-06T00:00:00Z", false, [rc("z", "A", "2026-07-01", 0), rc("y", "A", "2026-07-01", -5)])]), [], "invalid receipts are never preserved");
}

/* ---- in-memory ledger ---- */
function makeDb() {
  const ledger: Row[] = [], summary: Row[] = [];
  const match = (r: Row, where: Row = {}) => Object.entries(where).every(([k, c]) => !(c && typeof c === "object" && "in" in c) ? r[k] === c : c.in.some((v: unknown) => (v instanceof Date ? v.getTime() === (r[k] as Date).getTime() : v === r[k])));
  const db = {
    dealerPaymentReceipt: {
      findMany: async ({ where }: Row) => ledger.filter((r) => match(r, where)),
      deleteMany: async ({ where }: Row) => { const hit = (r: Row) => r.sourceKind === where.sourceKind && where.OR.some((o: Row) => o.dealerId === r.dealerId && o.receiptDate.getTime() === r.receiptDate.getTime()); const n = ledger.filter(hit).length; for (let i = ledger.length - 1; i >= 0; i--) if (hit(ledger[i]!)) ledger.splice(i, 1); return { count: n }; },
      createMany: async ({ data }: Row) => { for (const x of data) { if (ledger.some((r) => r.dealerId === x.dealerId && r.receiptDate.getTime() === x.receiptDate.getTime() && Number(r.amount) === Number(x.amount) && r.occurrence === x.occurrence)) continue; ledger.push({ ...x }); } return { count: data.length }; },
    },
    dealerLastPayment: {
      findMany: async ({ where }: Row) => summary.filter((r) => match(r, where)),
      update: async ({ where, data }: Row) => { Object.assign(summary.find((r) => r.dealerId === where.dealerId)!, data); },
      upsert: async ({ where, create, update }: Row) => { const r = summary.find((x) => x.dealerId === where.dealerId); if (r) Object.assign(r, update); else summary.push({ ...create }); },
    },
  };
  return { db: db as unknown as PaymentDb, ledger, summary };
}
const snap = (s: Row[], id: string) => { const r = s.find((x) => x.dealerId === id); return r ? [r.paymentDate.toISOString().slice(0, 10), Number(r.amount)] : null; };
const f = (dealerId: string, date: string, amount: number, sourceOrder = 0, extra: Row = {}) => ({ dealerId, date, amount, sourceOrder, ...extra });

async function main() {
  const { db, ledger, summary } = makeDb();
  const A = { sourceKind: "REGULAR", importId: "i1" };
  // 1. no payment → saved; 2. newer replaces date + amount; 3. older leaves it
  await acceptReceipts(db, [f("a", "2026-09-01", 100)], A, TODAY);
  assert.deepEqual(snap(summary, "a"), ["2026-09-01", 100]);
  await acceptReceipts(db, [f("a", "2026-09-10", 250)], { ...A, importId: "i2" }, TODAY);
  assert.deepEqual(snap(summary, "a"), ["2026-09-10", 250], "case 1: existing 1 Sep, new 10 Sep → date and amount move together");
  await acceptReceipts(db, [f("a", "2026-09-01", 99999)], { ...A, importId: "i3" }, TODAY);
  assert.deepEqual(snap(summary, "a"), ["2026-09-10", 250], "case 2: an older upload never moves the date back (nor lends its amount)");
  // same date: genuine extra added, accepted ones not recounted; identical file again; overlapping file
  await acceptReceipts(db, [f("a", "2026-09-10", 250, 0), f("a", "2026-09-10", 50, 1)], { ...A, importId: "i4" }, TODAY);
  assert.deepEqual(snap(summary, "a"), ["2026-09-10", 300], "case 3: same date → 250 (already accepted) + 50 (new)");
  const rows = ledger.length;
  for (let i = 0; i < 3; i++) await acceptReceipts(db, [f("a", "2026-09-10", 250, 0), f("a", "2026-09-10", 50, 1)], { ...A, importId: `again-${i}` }, TODAY);
  assert.equal(ledger.length, rows); assert.deepEqual(snap(summary, "a"), ["2026-09-10", 300], "case 5/6: identical or overlapping files never increase the amount");
  // dealer absent from a later file keeps its payment
  await acceptReceipts(db, [f("b", "2026-09-20", 10)], { ...A, importId: "i9" }, TODAY);
  assert.deepEqual(snap(summary, "a"), ["2026-09-10", 300], "case 4: absent dealer keeps its recorded payment");
  // multiplicity of genuine identical rows
  await acceptReceipts(db, [f("c", "2026-09-05", 500, 0), f("c", "2026-09-05", 500, 1)], A, TODAY);
  assert.deepEqual(snap(summary, "c"), ["2026-09-05", 1000], "two genuine identical receipts are both counted");
  await acceptReceipts(db, [f("c", "2026-09-05", 500, 0), f("c", "2026-09-05", 500, 1), f("c", "2026-09-05", 500, 2)], { ...A, importId: "x" }, TODAY);
  assert.deepEqual(snap(summary, "c"), ["2026-09-05", 1500], "a file with one more identical row adds exactly one");
  // regular copy + historical copy of one receipt; a reviewer-confirmed distinct row is added
  await acceptReceipts(db, [f("a", "2026-09-10", 250, 0)], { sourceKind: "HISTORICAL", importId: "h1" }, TODAY);
  assert.deepEqual(snap(summary, "a"), ["2026-09-10", 300], "case 7: the same receipt arriving as HISTORICAL is not counted again");
  await acceptReceipts(db, [f("a", "2026-09-10", 250, 0, { distinct: true })], { sourceKind: "HISTORICAL", importId: "h2" }, TODAY);
  assert.deepEqual(snap(summary, "a"), ["2026-09-10", 550], "…unless the reviewer explicitly confirmed it as a distinct receipt");
  // snapshot is a fallback only
  ledger.push({ dealerId: "s", receiptDate: d("2026-08-01"), amount: 400, occurrence: 1, sourceKind: "LEGACY_SNAPSHOT" });
  await acceptReceipts(db, [f("s", "2026-08-01", 250, 0), f("s", "2026-08-01", 150, 1)], A, TODAY);
  assert.deepEqual(snap(summary, "s"), ["2026-08-01", 400], "case 8: individual receipts replace the snapshot of their date (250 + 150), never snapshot + receipts");
  // real receipts replace the snapshot of their date, and later same-day receipts still add up (the snapshot never shadows an identical-looking receipt)
  await acceptReceipts(db, [f("s2", "2026-08-02", 250, 0)], A, TODAY);
  ledger.push({ dealerId: "s3", receiptDate: d("2026-08-03"), amount: 250, occurrence: 1, sourceKind: "LEGACY_SNAPSHOT" });
  await acceptReceipts(db, [f("s3", "2026-08-03", 250, 0)], A, TODAY);
  assert.equal(ledger.filter((r) => r.dealerId === "s3").length, 1);
  assert.equal(ledger.find((r) => r.dealerId === "s3")!.sourceKind, "REGULAR", "an identical receipt takes over from its snapshot (not skipped as already accepted)");
  await acceptReceipts(db, [f("s3", "2026-08-03", 250, 0), f("s3", "2026-08-03", 100, 1)], A, TODAY);
  assert.deepEqual(snap(summary, "s3"), ["2026-08-03", 350], "…so a later same-day receipt adds to it instead of replacing it");
  // strict verification: occurrences, not just keys
  {
    const rows = [f("m", "2026-09-01", 500, 0), f("m", "2026-09-01", 500, 1)];
    await acceptReceipts(db, [rows[0]!], A, TODAY);
    const problems = await missingPermanentPayments(db, rows, TODAY);
    assert.ok(problems.some((p) => /occurrence 2/.test(p)), "two genuine identical receipts need BOTH occurrences — one is not enough");
    await acceptReceipts(db, rows, A, TODAY);
    assert.deepEqual(await missingPermanentPayments(db, rows, TODAY), [], "complete once both are stored");
    assert.ok((await missingPermanentPayments(db, rows, TODAY, new Map([["m", { date: "2026-09-30", amount: 1 }]]))).some((p) => /not preserved/.test(p)), "a previous payment that is no longer represented is reported");
    summary.length = 0; // simulate a lost latest-payment record
    assert.ok((await missingPermanentPayments(db, rows, TODAY)).some((p) => /no latest-payment record/.test(p)), "a missing summary is a failure, not a success");
  }
  // future-dated receipt: stored, not effective yet, effective later without another upload
  await acceptReceipts(db, [f("t", "2026-10-01", 10), f("t", "2026-12-01", 99)], A, TODAY);
  assert.deepEqual(snap(summary, "t"), ["2026-10-01", 10]);
  const { refreshLastPayments } = await import("./dealer-last-payment");
  await refreshLastPayments(db, ["t"], "2026-12-05");
  assert.deepEqual(snap(summary, "t"), ["2026-12-01", 99], "case 11 (future): picked up once its date has arrived");
  // invalid rows are ignored
  const none = await acceptReceipts(db, [f("z", "bad", 5), f("z", "2026-09-01", -5)], A, TODAY);
  assert.deepEqual([none.accepted, snap(summary, "z")], [0, null]);

  /* ---- wiring ---- */
  const read = (p: string) => readFileSync(p, "utf8");
  const hist = read("src/features/historical-daybook/service.server.ts");
  const retain = hist.slice(hist.indexOf("async function retainInTx"));
  assert.ok(retain.indexOf("initializeDealers(tx,") < retain.indexOf("isActive: false") && retain.indexOf("preserveSupersededReceipts(tx, today") < retain.indexOf("isActive: false") && retain.includes("missingPermanentPayments(tx, incoming, today, previous)"), "retention preserves BEFORE it deactivates and proves the result (behaviour: dealer-last-payment.integration.ts)");
  const commit = hist.slice(hist.indexOf("export async function commitHistoricalDaybook"), hist.indexOf("export interface RegularReceipt"));
  assert.ok(commit.includes("acceptReceipts(tx,") && commit.indexOf("acceptReceipts(tx,") < commit.indexOf("reconcileBillingExceptionsSafely"), "historical commit: ledger acceptance inside its transaction, billing reconciliation after it");
  const recovery = read("src/features/recovery/service.server.ts"), dayBook = recovery.slice(recovery.indexOf("export async function commitDaybook"));
  assert.ok(dayBook.indexOf("processLastPaymentJob(jobId)") > dayBook.indexOf("timeout: 60000") && dayBook.indexOf("tx.lastPaymentJob.create") < dayBook.indexOf("timeout: 60000") && dayBook.indexOf("preserveBeforeDaybookCommit(") < dayBook.indexOf("tx.lastPaymentJob.create"), "durable job written WITH the financial commit; preparation before it; processing after it (isolated)");
  const reportServer = read("src/features/reports/last-payment-report.server.ts");
  assert.ok(!/isActive/.test(reportServer.replace(/\/\/.*$/gm, "")), "the report no longer filters on Dealer.isActive (inactive dealers are listed; soft-deleted stay hidden)");
  assert.ok(reportServer.includes("deletedAt: null"));
  const reader = read("src/lib/dealer-last-payment.server.ts").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\.(create|createMany|update|upsert|delete|deleteMany|updateMany)\(|\$executeRaw/.test(reader), "reading the report writes nothing");
  assert.ok(/Restrict/.test(read("prisma/schema.prisma").slice(read("prisma/schema.prisma").indexOf("model DealerPaymentReceipt"))) && /dealerId    String   @id/.test(read("prisma/schema.prisma")), "ledger identity + one latest-payment row per dealer, restrict deletes");
  const script = read("scripts/backfill-dealer-last-payment.ts");
  assert.ok(script.includes("PREVIEW") && script.includes("owner-signed-off") && script.includes("pg_advisory_xact_lock(79241362)"), "backfill: dry run by default, owner sign-off for non-local, serialized with uploads");
  {
  const repair = readFileSync("scripts/repair-superseded-receipts.ts", "utf8");
  assert.ok(repair.includes("DRY RUN") && repair.includes("owner-signed-off") && repair.includes("pg_advisory_xact_lock(79241362)") && repair.includes("DryRunRollback") && repair.includes("cmv6boe51000ll506xsc4xcuo"), "repair: dry run by default, explicit receipt ids, sign-off for a non-local database, the receipt-store lock");
}
console.log("dealer-last-payment.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
