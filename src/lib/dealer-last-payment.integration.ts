/**
 * Persistent latest payment + one-row-per-dealer report against a REAL, disposable PostgreSQL database (advisory locks, unique identities, rollback and the
 * real Day Book commits cannot be proven by an in-memory fake).
 *
 *   createdb dealer_last_payment_test && DATABASE_URL=postgresql://localhost:5432/dealer_last_payment_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   DEALER_LAST_PAYMENT_TEST_URL=postgresql://localhost:5432/dealer_last_payment_test npm run test:dealer-last-payment:db
 *
 * Only a LOCAL database named `dealer_last_payment_test` is permitted — the script TRUNCATEs the tables it uses.
 */
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";
import { currentBusinessDate } from "@/lib/daily-work";
import { parseLastPaymentReportParams } from "@/lib/last-payment-report";
import { backfillDealerLastPayments, preserveSupersededReceipts } from "@/lib/dealer-last-payment";

process.env.LAST_PAYMENT_JOB_KICK = "off"; // the background retry is exercised explicitly (scenario 11); elsewhere tests drive processing themselves
const url = process.env.DEALER_LAST_PAYMENT_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/dealer_last_payment_test")
  throw new Error("Only a local database named dealer_last_payment_test is permitted (set DEALER_LAST_PAYMENT_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => tx.auditLog.create({ data }) },
  "@/features/cn-requests/service.server": { latestCnRequestStatusByDealer: async () => new Map() },
});
const report = load<typeof import("@/features/reports/last-payment-report.server")>("src/features/reports/last-payment-report.server.ts");
const be = load<typeof import("@/features/reports/billing-exception.server")>("src/features/reports/billing-exception.server.ts");
const historical = load<typeof import("@/features/historical-daybook/service.server")>("src/features/historical-daybook/service.server.ts");
const recovery = load<typeof import("@/features/recovery/service.server")>("src/features/recovery/service.server.ts");
const read = load<typeof import("@/lib/last-payment.server")>("src/lib/last-payment.server.ts");

const eq = (actual: unknown, expected: unknown, message?: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const today = currentBusinessDate();
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10); // n days ago
const admin: AuthContext = { userId: "admin", username: "admin", role: Role.SUPER_ADMIN, groupId: null };
const params = (over = {}) => ({ ...parseLastPaymentReportParams(new URLSearchParams()), pageSize: 500, ...over });
const header = ["Date", "Particulars", "Vch Type", "Vch No.", "Credit Amount"];
function book(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), "Day Book");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const rcpt = (n: number, party: string, amount: number, vch = "V") => [day(n), party, "Receipt", vch, amount];
const upload = (month: string, rows: unknown[][], name = `f-${Math.random()}.xlsx`) => recovery.commitDaybook(admin, book(rows), name, { seasonMonthId: month });
const row = async (id: string, at = today) => (await report.getLastPaymentReport(admin, params(), at)).items.find((r) => r.dealerId === id)!;
const summary = async (id: string) => { const s = await prisma.dealerLastPayment.findUnique({ where: { dealerId: id } }); return s ? { date: s.paymentDate.toISOString().slice(0, 10), amount: Number(s.amount) } : null; };
const ledgerCount = (id: string) => prisma.dealerPaymentReceipt.count({ where: { dealerId: id } });

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "BillingException","DealerPaymentReceipt","DealerLastPayment","LastPaymentReceipt","LastPaymentImport","LastPaymentJob","RecoveryPlanDealer","RecoveryPlan","SeasonMonth","Season","DealerAlias","DealerAssignment","Dealer","AuditLog","User","UserGroup" CASCADE`);
  await prisma.userGroup.create({ data: { id: "g1", name: "MP" } });
  await prisma.user.create({ data: { id: "admin", name: "Admin", username: "admin", passwordHash: "x", role: Role.SUPER_ADMIN } });
  await prisma.user.create({ data: { id: "so1", name: "Arjun", username: "so1", passwordHash: "x", role: Role.SALES_OFFICER, groupId: "g1", territory: "BHOPAL" } });
  const names: Record<string, string> = { X: "Xeno Traders", Y: "Yash Stores", Z: "Zed Agro", W: "Wave Corp", P: "Pending Co", Q: "Quick Mart" };
  for (const [id, name] of Object.entries(names)) { await prisma.dealer.create({ data: { id, name } }); await prisma.dealerAssignment.create({ data: { dealerId: id, officerId: "so1", effectiveFrom: new Date("2024-01-01") } }); }
  // an INACTIVE dealer (with an alias, owned by nobody) and a SOFT-DELETED one
  await prisma.dealer.create({ data: { id: "I", name: "Idle Dealer", isActive: false, status: "INACTIVE" } });
  await prisma.dealer.create({ data: { id: "D", name: "Deleted Dealer", isActive: false, deletedAt: new Date() } });
  await prisma.dealerAlias.create({ data: { systemDealerId: "I", tallyName: "Idle (Tally)", tallyKey: "idletally" } });
  await prisma.dealerAlias.create({ data: { systemDealerId: "X", tallyName: "Xeno Tally One", tallyKey: "xenotallyone" } });
  await prisma.dealerAlias.create({ data: { systemDealerId: "X", tallyName: "Xeno Tally Two", tallyKey: "xenotallytwo" } }); // two aliases, one report row
  await prisma.season.create({ data: { id: "s", name: "Rabi", year: 2026, startMonth: 4, startYear: 2026 } });
  for (const [id, m] of [["m1", 8], ["m2", 9], ["m3", 10]] as const) {
    await prisma.seasonMonth.create({ data: { id, seasonId: "s", name: `Month ${m}`, order: m - 7, calendarMonth: m, calendarYear: 2026 } });
    await prisma.recoveryPlan.create({ data: { id: `rp-${id}`, seasonId: "s", seasonMonthId: id, officerId: "so1", cutoffDate: new Date(`2026-${String(m).padStart(2, "0")}-01T00:00:00Z`), status: "APPROVED", dealers: { create: ["X", "Y", "Z", "W", "P", "Q"].map((dealerId) => ({ dealerId })) } } });
  }

  /* ---- 1. population: one row per Dealer Master id, inactive included, soft-deleted hidden, aliases irrelevant ---- */
  const rows0 = (await report.getLastPaymentReport(admin, params(), today)).items;
  eq(rows0.map((r) => r.dealerId).sort(), ["I", "P", "Q", "W", "X", "Y", "Z"], "every non-deleted dealer (active AND inactive), once each");
  assert.equal(new Set(rows0.map((r) => r.dealerId)).size, rows0.length);
  const inactive = rows0.find((r) => r.dealerId === "I")!;
  eq([inactive.status, inactive.lastPaymentDate, inactive.amount, inactive.days, inactive.billingStatus], ["INACTIVE", null, null, null, "UNAVAILABLE"], "no payment: blank values and the neutral Unavailable status");
  assert.equal(rows0.filter((r) => r.dealerId === "X").length, 1, "two aliases → still one row");
  await prisma.dealerAlias.update({ where: { tallyKey: "xenotallyone" }, data: { tallyName: "Xeno Renamed", tallyKey: "xenorenamed" } });
  await prisma.dealer.update({ where: { id: "X" }, data: { name: "Xeno Traders Ltd", status: "DEFAULTER" } });
  assert.equal((await report.getLastPaymentReport(admin, params(), today)).total, 7, "renames / status changes never add a row");
  await prisma.dealer.create({ data: { id: "N", name: "Brand New Dealer" } });
  assert.ok((await report.getLastPaymentReport(admin, params(), today)).items.some((r) => r.dealerId === "N"), "a new Dealer Master record appears automatically");
  await prisma.dealer.update({ where: { id: "X" }, data: { name: "Xeno Traders", status: "ACTIVE" } });
  await prisma.dealer.delete({ where: { id: "N" } });

  /* ---- 2. newer / older / same-date, date and amount together ---- */
  await upload("m2", [rcpt(40, "Xeno Traders", 1000, "A1")], "u1.xlsx");
  eq(await summary("X"), { date: day(40), amount: 1000 }, "no payment yet → saved");
  await upload("m3", [rcpt(20, "Xeno Traders", 2500, "A2")], "u2.xlsx");
  eq(await summary("X"), { date: day(20), amount: 2500 }, "newer receipt replaces the date AND its amount together");
  await upload("m1", [rcpt(60, "Xeno Traders", 9999, "A0")], "u3.xlsx");
  eq(await summary("X"), { date: day(20), amount: 2500 }, "an older receipt leaves the latest payment unchanged (and its larger amount is ignored)");
  // same date: an extra genuine receipt is added; the ones already accepted are not counted again
  await upload("m3", [rcpt(20, "Xeno Traders", 2500, "A2"), rcpt(20, "Xeno Traders", 700, "A3")], "u4.xlsx"); // replacement file of the SAME month (supersedes u2)
  eq(await summary("X"), { date: day(20), amount: 3200 }, "2500 (already accepted) + 700 (new) — not 2500 + 2500 + 700");
  await upload("m3", [rcpt(20, "Xeno Traders", 2500, "A2"), rcpt(20, "Xeno Traders", 700, "A3")], "u4-again.xlsx");
  eq(await summary("X"), { date: day(20), amount: 3200 }, "identical content re-uploaded (even under another name) → unchanged");
  const before = await ledgerCount("X");
  await upload("m3", [rcpt(20, "Xeno Traders", 2500, "A2"), rcpt(20, "Xeno Traders", 700, "A3")], "u4-third.xlsx");
  assert.equal(await ledgerCount("X"), before, "no new ledger rows on a repeat");
  // genuine identical repeats inside one file keep their multiplicity
  await upload("m2", [rcpt(10, "Yash Stores", 500, "B1"), rcpt(10, "Yash Stores", 500, "B2")], "y1.xlsx");
  eq(await summary("Y"), { date: day(10), amount: 1000 }, "two identical genuine receipts on the same day are both counted");
  await upload("m2", [rcpt(10, "Yash Stores", 500, "B1"), rcpt(10, "Yash Stores", 500, "B2"), rcpt(10, "Yash Stores", 500, "B3")], "y2.xlsx");
  eq(await summary("Y"), { date: day(10), amount: 1500 }, "a file with one MORE identical row adds only that one");
  // overlapping receipts delivered by a DIFFERENT month's file
  await upload("m3", [rcpt(10, "Yash Stores", 500, "B1"), rcpt(10, "Yash Stores", 500, "B2")], "y3.xlsx");
  eq(await summary("Y"), { date: day(10), amount: 1500 }, "an overlapping file of another month does not double-count");

  // a stored newer date is never replaced by an older upload (even if the ledger itself were behind)
  await prisma.dealerLastPayment.create({ data: { dealerId: "P", paymentDate: new Date(`${day(3)}T00:00:00Z`), amount: 111, basis: "RECEIPTS", asOfDate: new Date(`${today}T00:00:00Z`) } });
  await upload("m1", [rcpt(40, "Pending Co", 5000, "P1")], "p1.xlsx");
  eq(await summary("P"), { date: day(3), amount: 111 }, "monotonic: older upload leaves a newer stored payment alone");

  /* ---- 3. replacement & deactivation never lose accepted payments; absent dealers keep theirs ---- */
  await upload("m2", [rcpt(30, "Zed Agro", 800, "C1"), rcpt(30, "Wave Corp", 300, "C2")], "z1.xlsx");
  await upload("m2", [rcpt(30, "Zed Agro", 800, "C1")], "z2.xlsx"); // same-month replacement WITHOUT Wave Corp
  eq(await summary("W"), { date: day(30), amount: 300 }, "a dealer absent from the replacement file keeps its recorded payment");
  eq((await row("W")).lastPaymentDate, day(30));
  await prisma.lastPaymentImport.updateMany({ data: { isActive: false } });
  eq((await row("X")).amount, 3200, "deactivating EVERY import does not change the report");
  eq((await row("W")).lastPaymentDate, day(30));
  await prisma.lastPaymentImport.updateMany({ data: { isActive: true } });

  /* ---- 4. regular ↔ historical overlap ---- */
  const hist = book([rcpt(20, "Xeno Traders", 2500, "H1")]);
  const preview = await historical.analyzeHistoricalDaybook(admin, hist, "h.xlsx", {});
  assert.ok(preview.rows[0]!.reviewReasons.some((r: string) => /duplicate|conflict/i.test(r)) && !preview.canCommit, "the same receipt already retained from a regular upload must be reviewed — never silently doubled");
  const rowKey = preview.rows[0]!.rowKey;
  const exclude = await historical.analyzeHistoricalDaybook(admin, hist, "h.xlsx", { reviews: [{ rowKey, action: "EXCLUDE" }] });
  assert.ok(exclude.rows[0]!.excluded);
  const keep = { reviews: [{ rowKey, action: "KEEP" as const }] };
  const keepPreview = await historical.analyzeHistoricalDaybook(admin, hist, "h.xlsx", keep);
  await historical.commitHistoricalDaybook(admin, hist, "h.xlsx", { ...keep, previewToken: keepPreview.previewToken, confirmed: true });
  eq(await summary("X"), { date: day(20), amount: 5700 }, "only an EXPLICIT 'keep as a distinct receipt' adds it (2500 more)");

  /* ---- 5. future-dated receipts become eligible later without a new upload ---- */
  await prisma.dealerPaymentReceipt.create({ data: { dealerId: "Q", receiptDate: new Date(`${day(-5)}T00:00:00Z`), amount: 777, occurrence: 1, sourceKind: "REGULAR" } });
  await prisma.dealerPaymentReceipt.create({ data: { dealerId: "Q", receiptDate: new Date(`${day(30)}T00:00:00Z`), amount: 100, occurrence: 1, sourceKind: "REGULAR" } });
  await prisma.dealerLastPayment.create({ data: { dealerId: "Q", paymentDate: new Date(`${day(30)}T00:00:00Z`), amount: 100, basis: "RECEIPTS", asOfDate: new Date(`${today}T00:00:00Z`) } });
  eq([(await row("Q")).lastPaymentDate, (await row("Q")).amount], [day(30), 100], "today: the future-dated receipt does not count");
  eq([(await row("Q", day(-6))).lastPaymentDate, (await row("Q", day(-6))).amount], [day(-5), 777], "once its day has arrived it is picked up (read only — nothing was uploaded or written)");
  assert.equal((await summary("Q"))!.date, day(30), "the report read wrote nothing");

  /* ---- 6. historical month-end consumers keep their own as-of selection ---- */
  const asOf = await read.latestReceiptAsOfByDealer(["X"], new Date(`${day(30)}T00:00:00Z`));
  assert.ok((asOf.get("X")?.date ?? "") <= day(30), "Recovery's month-end query still answers 'as of then', never today's latest");

  /* ---- 7. concurrent uploads: newest date and the right same-day sum ---- */
  await prisma.dealer.create({ data: { id: "R", name: "Race Dealer" } }); await prisma.dealerAssignment.create({ data: { dealerId: "R", officerId: "so1", effectiveFrom: new Date("2024-01-01") } });
  for (const m of ["m1", "m2", "m3"]) await prisma.recoveryPlanDealer.create({ data: { recoveryPlanId: `rp-${m}`, dealerId: "R" } });
  const results = await Promise.allSettled([
    upload("m1", [rcpt(15, "Race Dealer", 100, "R1")], "r1.xlsx"), upload("m2", [rcpt(5, "Race Dealer", 200, "R2"), rcpt(5, "Race Dealer", 50, "R3")], "r2.xlsx"),
    upload("m3", [rcpt(25, "Race Dealer", 999, "R4")], "r3.xlsx"), upload("m2", [rcpt(5, "Race Dealer", 200, "R2"), rcpt(5, "Race Dealer", 50, "R3")], "r4.xlsx"),
  ]);
  assert.ok(results.every((r) => r.status === "fulfilled"));
  eq(await summary("R"), { date: day(5), amount: 250 }, "whatever the finishing order: newest date, same-day sum counted once");

  /* ---- 8. exceptions follow the persistent payment ---- */
  await prisma.dealer.create({ data: { id: "E", name: "Exception Dealer" } }); await prisma.dealerAssignment.create({ data: { dealerId: "E", officerId: "so1", effectiveFrom: new Date("2024-01-01") } });
  for (const m of ["m1", "m2", "m3"]) await prisma.recoveryPlanDealer.create({ data: { recoveryPlanId: `rp-${m}`, dealerId: "E" } });
  await upload("m1", [rcpt(60, "Exception Dealer", 4000, "E1")], "e1.xlsx");
  eq([(await row("E")).days, (await row("E")).billingStatus], [60, "BLOCKED"]);
  const created = await be.createBillingException(admin, { dealerId: "E", billingDate: day(1), billNo: "E-1", authPerson: "Varun sir", requestId: "req-e-123456", billingAmount: 500, paymentCondition: "NO" });
  eq([created.snapshot.days, created.exceptionStatus, (await row("E")).billingStatus], [60, "CURRENT", "BILLING_EXCEPTION"]);
  await prisma.lastPaymentImport.updateMany({ data: { isActive: false } }); // replacing / deactivating imports changes neither the days nor the exception
  eq([(await row("E")).days, (await row("E")).billingStatus], [60, "BILLING_EXCEPTION"]);
  const done = await upload("m2", [rcpt(5, "Exception Dealer", 1200, "E2")], "e2.xlsx");
  assert.ok(!done.billingExceptionWarning);
  eq([(await row("E")).days, (await row("E")).billingStatus], [5, "OPEN"], "an accepted newer payment makes the dealer Open…");
  const stored = await prisma.billingException.findUniqueOrThrow({ where: { id: created.id } });
  eq([stored.status, stored.resolvedDays, stored.snapDays, stored.snapLastPaymentDate?.toISOString().slice(0, 10)], ["RESOLVED", 5, 60, day(60)], "…resolves the exception but keeps its original Days / payment snapshot");
  assert.equal((await be.listBillingExceptions(admin, "current", params(), today)).total, 0);
  assert.equal((await be.listBillingExceptions(admin, "history", params(), today)).total, 1);
  // a RESOLVED exception never becomes Current again when Days later grow past 45 (the dealer is simply Blocked), and History keeps its original snapshot
  const later = day(-60);
  await be.reconcileBillingExceptions({ today: later, actor: { userId: "admin" } });
  eq([(await prisma.billingException.findUniqueOrThrow({ where: { id: created.id } })).status, (await row("E", later)).days, (await row("E", later)).billingStatus], ["RESOLVED", 65, "BLOCKED"], "resolved stays resolved; Days > 45 → Blocked (not Billing Exception)");
  assert.equal((await be.listBillingExceptions(admin, "current", params(), later)).total, 0);
  const histRow = (await be.listBillingExceptions(admin, "history", params(), later)).items[0]!;
  eq([histRow.days, histRow.lastPaymentDate, histRow.amount], [60, day(60), 4000], "History keeps the original payment / Days snapshot");
  await prisma.lastPaymentImport.updateMany({ data: { isActive: true } });

  /* ---- 9. backfill: restartable, idempotent, never resurrects superseded batches, snapshots are fallback-only ---- */
  for (const id of ["L1", "L2", "L3"]) await prisma.dealer.create({ data: { id, name: `Legacy ${id}` } });
  const batch = (kind: string, scopeKey: string, active: boolean, tag: string) => prisma.lastPaymentImport.create({ data: { kind, scopeKey, fileHash: `bf-${tag}`, workbookName: `${tag}.xlsx`, uploadedById: "admin", summary: "{}", isActive: active } });
  const act = await batch("REGULAR", "bf-a", true, "act"), old = await batch("REGULAR", "bf-a", false, "superseded"), idle = await batch("HISTORICAL", "", true, "idle");
  const put = (importId: string, dealerId: string, d: number, amount: number, order: number) => prisma.lastPaymentReceipt.create({ data: { importId, dealerId, rowKey: `${importId}-${order}`, sourceOrder: order, receiptDate: new Date(`${day(d)}T00:00:00Z`), creditAmount: amount } });
  await put(act.id, "L1", 12, 100, 1); await put(act.id, "L1", 12, 100, 2); await put(act.id, "L1", 12, 50, 3); // L1: 250 on day-12 (two identical rows kept)
  await put(old.id, "L1", 2, 9999, 1);                                                                          // superseded: newer, must NOT be resurrected
  await put(idle.id, "I", 33, 300, 1);                                                                          // the INACTIVE dealer's payment
  await put(act.id, "L2", 20, 400, 4);
  const snap = await prisma.recoveryPlan.findFirstOrThrow({ where: { id: "rp-m3" } });
  await prisma.recoveryPlanDealer.create({ data: { recoveryPlanId: snap.id, dealerId: "L2", lastReceiptDate: new Date(`${day(20)}T00:00:00Z`), lastReceiptAmount: 400 } }); // snapshot of the SAME payment as the receipt
  await prisma.recoveryPlanDealer.create({ data: { recoveryPlanId: snap.id, dealerId: "L3", lastReceiptDate: new Date(`${day(70)}T00:00:00Z`), lastReceiptAmount: 640 } }); // snapshot-only dealer
  await prisma.recoveryPlanDealer.create({ data: { recoveryPlanId: snap.id, dealerId: "L1", lastReceiptDate: new Date(`${day(12)}T00:00:00Z`), lastReceiptAmount: 999 } }); // a snapshot that DISAGREES with the receipts of its date
  await put(old.id, "L2", 20, 500, 2);                                                                                                                                     // an older file version that disagrees about L2's day
  const guarded = JSON.stringify([await prisma.billingException.findMany({ orderBy: { id: "asc" } }), await prisma.billingExceptionTask.findMany({ orderBy: { id: "asc" } }), await prisma.dealerAssignment.findMany({ orderBy: { id: "asc" } })]);
  const rpdSums = JSON.stringify((await prisma.recoveryPlanDealer.findMany({ orderBy: { id: "asc" }, select: { id: true, liveRecovery: true, srCr: true, outstanding: true, lastReceiptDate: true } })));
  const slice1 = await prisma.$transaction(async (tx) => { const r = await backfillDealerLastPayments(tx as never, today, { dealerIds: ["L1"] }); throw Object.assign(new Error("rollback"), { stats: r }); }).catch((e: { stats?: Awaited<ReturnType<typeof backfillDealerLastPayments>> }) => e.stats!);
  eq([slice1.dealersExamined, slice1.dealersMissingBefore, (await summary("L1"))], [1, 1, null], "a slice only examines its dealers, and a rolled-back preview writes nothing");
  const run1 = await backfillDealerLastPayments(prisma as never, today);
  assert.ok(run1.dealersMissingBefore >= 4 && ["L1", "L2", "L3", "I"].every((id) => run1.changes.some((c) => c.dealerId === id && c.before === null && c.after)), "the preview lists every dealer that was missing permanent records, with before → after");
  assert.ok(run1.conflicts.some((c) => c.dealerId === "L1" && c.kind === "SNAPSHOT_DIFFERS_FROM_RECEIPTS") && run1.conflicts.some((c) => c.dealerId === "L2" && c.kind === "FILE_VERSIONS_DIFFER"), "conflicting sources are reported for review");
  eq(await summary("L2"), { date: day(20), amount: 400 }, "…and the active file's value is the one used");
  eq([JSON.stringify([await prisma.billingException.findMany({ orderBy: { id: "asc" } }), await prisma.billingExceptionTask.findMany({ orderBy: { id: "asc" } }), await prisma.dealerAssignment.findMany({ orderBy: { id: "asc" } })]) === guarded, JSON.stringify((await prisma.recoveryPlanDealer.findMany({ orderBy: { id: "asc" }, select: { id: true, liveRecovery: true, srCr: true, outstanding: true, lastReceiptDate: true } }))) === rpdSums], [true, true], "the backfill changes no exception, task, assignment or Recovery value");
  eq(await summary("L1"), { date: day(12), amount: 250 }, "active receipts only, multiplicity kept, superseded 9999 ignored");
  eq(await summary("L2"), { date: day(20), amount: 400 }, "snapshot and receipt of the same payment are NOT added (400, not 800)");
  eq(await summary("L3"), { date: day(70), amount: 640 }, "a snapshot-only dealer keeps its fallback value");
  eq(await summary("I"), { date: day(33), amount: 300 }, "an inactive dealer's payment is carried");
  assert.ok(run1.compared >= 4 && !run1.differences.some((d) => ["L1", "L2", "L3", "I"].includes(d.dealerId)), `the seeded legacy dealers match the previous selection exactly: ${JSON.stringify(run1.differences)}`);
  // …while the dealers fed by the overlapping test uploads above DIFFER on purpose: the previous selection summed identical receipts delivered by several active imports.
  const x = run1.differences.find((d) => d.dealerId === "X");
  assert.ok(x && x.legacy!.amount > x.persisted!.amount && x.legacy!.date === x.persisted!.date, "the comparison exposes (and the new state removes) the cross-import double counting");
  const counts = [await prisma.dealerPaymentReceipt.count(), await prisma.dealerLastPayment.count()];
  const run2 = await backfillDealerLastPayments(prisma as never, today); // restart / re-run
  eq([await prisma.dealerPaymentReceipt.count(), await prisma.dealerLastPayment.count()], counts, "re-running creates nothing new");
  eq([run2.receiptsAccepted, run2.snapshotsAdded, run2.changes.length, run2.dealersMissingBefore], [0, 0, 0, 0], "idempotent: a second run changes nothing and finds nothing missing");
  eq([(await row("L1")).amount, (await row("L3")).days], [250, 70]);

  /* ---- 10. preservation through the EXISTING upload: legacy receipts, replacement, retries, failures ---- */
  const mk = async (id: string, name: string) => { await prisma.dealer.create({ data: { id, name } }); await prisma.dealerAssignment.create({ data: { dealerId: id, officerId: "so1", effectiveFrom: new Date("2024-01-01") } }); for (const m of ["m1", "m2", "m3"]) await prisma.recoveryPlanDealer.create({ data: { recoveryPlanId: `rp-${m}`, dealerId: id } }); };
  const legacyFile = (tag: string, scopeKey: string, active: boolean) => prisma.lastPaymentImport.create({ data: { kind: "REGULAR", scopeKey, fileHash: `lg-${tag}`, workbookName: `${tag}.xlsx`, uploadedById: "admin", summary: "{}", isActive: active, createdAt: new Date("2026-01-01T00:00:00Z") } });
  const legacyReceipt = (importId: string, dealerId: string, d: number, amount: number, order: number) => prisma.lastPaymentReceipt.create({ data: { importId, dealerId, rowKey: `${importId}-${order}`, sourceOrder: order, receiptDate: new Date(`${day(d)}T00:00:00Z`), creditAmount: amount } });
  const ledgerIsEmpty = async (id: string) => (await ledgerCount(id)) === 0 && (await summary(id)) === null;

  // (a) a receipt imported BEFORE permanent storage, in the file that is still active, survives the next replacement — for the dealer the replacement does not mention
  await mk("LA", "Lega Alpha"); await mk("LB", "Lega Beta");
  const lgAct = await legacyFile("act", "m1", true); await legacyReceipt(lgAct.id, "LA", 50, 700, 1); await legacyReceipt(lgAct.id, "LB", 45, 400, 2);
  assert.ok(await ledgerIsEmpty("LA"), "precondition: legacy payments have no permanent record");
  const rpdBefore = await prisma.recoveryPlanDealer.findFirstOrThrow({ where: { recoveryPlanId: "rp-m1", dealerId: "LB" } });
  const rep = await upload("m1", [rcpt(5, "Lega Beta", 900, "LB1")], "lg-replace.xlsx");
  assert.ok(!rep.receiptHistoryWarning && !rep.billingExceptionWarning, "a normal upload completes both consumers without warnings");
  eq(await summary("LA"), { date: day(50), amount: 700 }, "LA (absent from the replacement) keeps its pre-existing payment — preserved BEFORE its file was deactivated");
  eq(await summary("LB"), { date: day(5), amount: 900 }, "LB: the new file's newer receipt wins");
  assert.equal((await prisma.lastPaymentImport.findUniqueOrThrow({ where: { id: lgAct.id } })).isActive, false, "the old file was replaced (existing behaviour)");
  eq([(await row("LA")).lastPaymentDate, (await row("LA")).amount, (await row("LA")).days], [day(50), 700, 50], "the report shows it");
  const rpdAfter = await prisma.recoveryPlanDealer.findFirstOrThrow({ where: { recoveryPlanId: "rp-m1", dealerId: "LB" } });
  eq([Number(rpdAfter.liveRecovery), rpdAfter.lastReceiptDate?.toISOString().slice(0, 10), Number(rpdAfter.lastReceiptAmount)], [900, day(5), 900], "Recovery's monthly values come from the SAME upload, by the existing rules");
  assert.notEqual(Number(rpdBefore.liveRecovery), 900);
  const laMonthEnd = await read.latestReceiptAsOfByDealer(["LA"], new Date(`${day(10)}T00:00:00Z`));
  assert.equal(laMonthEnd.get("LA")?.date ?? null, null, "Recovery's month-end source is untouched: an inactive file still does not feed it");

  // (b) the verified case: a file ALREADY replaced earlier, its dealer absent, two CURRENT exceptions waiting
  await mk("LC", "Lega Gamma");
  const lgOld = await legacyFile("old", "m1", false); const lcReceipt = await legacyReceipt(lgOld.id, "LC", 104, 120000, 1);
  const mkEx = (n: number) => prisma.billingException.create({ data: { dealerId: "LC", billingDate: new Date(`${day(1)}T00:00:00Z`), billNo: `LC-${n}`, authPerson: "Varun sir", createdById: "admin", requestId: `lc-req-000${n}`, snapDays: 104, snapLastPaymentDate: new Date(`${day(104)}T00:00:00Z`), snapAmount: 120000, snapParty: "Lega Gamma", snapDealerStatus: "ACTIVE", snapState: "MP", snapSalesOfficer: "Arjun", snapSalesOfficerId: "so1", billingAmount: 1000 * n, paymentCondition: false } });
  const ex1 = await mkEx(1), ex2 = await mkEx(2);
  eq([(await row("LC")).lastPaymentDate, (await row("LC")).days, (await row("LC")).billingStatus], [null, null, "UNAVAILABLE"], "reproduction: the payment is unavailable");
  assert.equal((await be.listBillingExceptions(admin, "current", params(), today)).items.filter((r: { dealerId: string }) => r.dealerId === "LC").length, 0, "reproduction: hidden from Current");
  assert.equal((await be.reconcileBillingExceptions({ today, actor: { userId: "admin" } })).resolved, 0, "a missing payment never resolves an exception");
  assert.equal((await prisma.billingException.count({ where: { dealerId: "LC", status: "CURRENT" } })), 2);
  const plan = await prisma.$transaction((tx) => preserveSupersededReceipts(tx as never, today, { onlyReceiptIds: [lcReceipt.id], dryRun: true }));
  eq(plan.eligible.map((p) => [p.dealerId, p.date, p.amount]), [["LC", day(104), 120000]], "dry run lists exactly the verified receipt");
  assert.ok(await ledgerIsEmpty("LC"), "a dry run writes nothing");
  const fixed = await prisma.$transaction((tx) => preserveSupersededReceipts(tx as never, today, { onlyReceiptIds: [lcReceipt.id] }));
  assert.equal(fixed.accepted, 1);
  eq(await summary("LC"), { date: day(104), amount: 120000 }, "the verified recovery restores the payment from its own receipt");
  eq([(await row("LC")).days, (await row("LC")).billingStatus], [104, "BILLING_EXCEPTION"]);
  const cur = (await be.listBillingExceptions(admin, "current", params(), today)).items.filter((r: { dealerId: string }) => r.dealerId === "LC");
  eq(cur.map((r: { exceptionId: string }) => r.exceptionId).sort(), [ex1.id, ex2.id].sort(), "both Current entries are back (multiple exceptions stay separate)");
  assert.equal((await be.listBillingExceptions(admin, "history", params(), today)).items.filter((r: { dealerId: string }) => r.dealerId === "LC").length, 2, "History is untouched");
  const again = await prisma.$transaction((tx) => preserveSupersededReceipts(tx as never, today, { onlyReceiptIds: [lcReceipt.id] }));
  eq([again.accepted, await ledgerCount("LC"), (await prisma.billingException.findUniqueOrThrow({ where: { id: ex1.id } })).snapDays], [0, 1, 104], "idempotent: a second run adds nothing, snapshots unchanged");
  // not everything inactive is eligible: Historical files and dealers an ACTIVE file covers are never resurrected
  await mk("LH", "Lega Hist");
  const lgHist = await prisma.lastPaymentImport.create({ data: { kind: "HISTORICAL", scopeKey: "", fileHash: "lg-hist", workbookName: "hist.xlsx", uploadedById: "admin", summary: "{}", isActive: false } });
  await legacyReceipt(lgHist.id, "LH", 90, 5, 1);
  const lgMix = await legacyFile("mix-old", "m3", false); await legacyReceipt(lgMix.id, "LA", 1, 123456, 9); // LA is covered by no active m3 file…
  const lgMixAct = await legacyFile("mix-act", "m3", true); await legacyReceipt(lgMixAct.id, "LB", 2, 1, 1);
  const swept = await prisma.$transaction((tx) => preserveSupersededReceipts(tx as never, today));
  assert.ok(!swept.eligible.some((p) => p.dealerId === "LH"), "a deactivated HISTORICAL file is not swept in");
  assert.ok(await ledgerIsEmpty("LH"));

  // (c) a retention FAILURE keeps the monthly values and warns; the same upload retried repairs it without duplicates
  await mk("LF", "Lega Fail");
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION lg_block() RETURNS trigger AS $$ BEGIN IF NEW."dealerId" = 'LF' THEN RAISE EXCEPTION 'injected ledger failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER lg_block_t BEFORE INSERT ON "DealerPaymentReceipt" FOR EACH ROW EXECUTE FUNCTION lg_block()`);
  const importsBefore = await prisma.lastPaymentImport.count();
  const failed = await upload("m3", [rcpt(7, "Lega Fail", 300, "F1")], "lg-fail.xlsx");
  assert.ok(failed.receiptHistoryWarning, "the failure is surfaced through the existing warning");
  eq([Number((await prisma.recoveryPlanDealer.findFirstOrThrow({ where: { recoveryPlanId: "rp-m3", dealerId: "LF" } })).liveRecovery), failed.receiptTotal], [300, 300], "the monthly Recovery update stays committed");
  eq([await prisma.lastPaymentImport.count(), await ledgerCount("LF")], [importsBefore, 0], "retention rolled back as a whole (no half-state)");
  await prisma.$executeRawUnsafe(`DROP TRIGGER lg_block_t ON "DealerPaymentReceipt"`);
  const retried = await upload("m3", [rcpt(7, "Lega Fail", 300, "F1")], "lg-fail.xlsx");
  assert.ok(!retried.receiptHistoryWarning);
  eq([await summary("LF"), await ledgerCount("LF")], [{ date: day(7), amount: 300 }, 1], "the retry creates the permanent records");
  eq(Number((await prisma.recoveryPlanDealer.findFirstOrThrow({ where: { recoveryPlanId: "rp-m3", dealerId: "LF" } })).liveRecovery), 300, "monthly totals did not accumulate");
  // …and a retention that SILENTLY stores nothing can no longer pass as success
  await mk("LG", "Lega Silent");
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION lg_skip() RETURNS trigger AS $$ BEGIN IF NEW."dealerId" = 'LG' THEN RETURN NULL; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER lg_skip_t BEFORE INSERT ON "DealerPaymentReceipt" FOR EACH ROW EXECUTE FUNCTION lg_skip()`);
  const silent = await upload("m3", [rcpt(8, "Lega Silent", 150, "G1")], "lg-silent.xlsx");
  assert.ok(silent.receiptHistoryWarning, "the post-condition catches a skipped permanent save and warns");
  assert.equal(await prisma.lastPaymentReceipt.count({ where: { dealerId: "LG" } }), 0, "no retained import without its permanent records");
  await prisma.$executeRawUnsafe(`DROP TRIGGER lg_skip_t ON "DealerPaymentReceipt"`);

  // (d) an EXISTING import whose permanent records are missing is repaired by the same upload (retry branch)
  await mk("LR", "Lega Retry");
  const first = await upload("m3", [rcpt(9, "Lega Retry", 250, "R1")], "lg-retry.xlsx");
  assert.ok(!first.receiptHistoryWarning && (await ledgerCount("LR")) === 1);
  await prisma.dealerLastPayment.deleteMany({ where: { dealerId: "LR" } }); await prisma.dealerPaymentReceipt.deleteMany({ where: { dealerId: "LR" } });
  const importCount = await prisma.lastPaymentImport.count();
  await upload("m3", [rcpt(9, "Lega Retry", 250, "R1")], "lg-retry.xlsx");
  eq([await summary("LR"), await ledgerCount("LR"), await prisma.lastPaymentImport.count()], [{ date: day(9), amount: 250 }, 1, importCount], "retry repairs the missing records, creates no second import and no duplicate");


  /* ---- 11. one upload, two consumers: separate eligibility, preservation for dealers INSIDE the replacement, durable retry ---- */
  const rpd = (month: string, dealerId: string) => prisma.recoveryPlanDealer.findFirst({ where: { recoveryPlan: { seasonMonthId: month }, dealerId } });
  const block = async (amount: number) => {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION lg_amount_block() RETURNS trigger AS $$ BEGIN IF NEW.amount = ${amount} AND NEW."sourceKind" = 'REGULAR' THEN RAISE EXCEPTION 'injected ledger failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS lg_amount_block_t ON "DealerPaymentReceipt"`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER lg_amount_block_t BEFORE INSERT ON "DealerPaymentReceipt" FOR EACH ROW EXECUTE FUNCTION lg_amount_block()`);
  };
  const unblock = () => prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS lg_amount_block_t ON "DealerPaymentReceipt"`);

  // (1) an UNINITIALIZED dealer whose previous, NEWER payment exists only in an active legacy file: an older receipt in the replacement must not replace it
  await mk("UA", "Uninit Alpha");
  const uaFile = await legacyFile("ua", "m2", true); await legacyReceipt(uaFile.id, "UA", 10, 800, 1);
  assert.ok(await ledgerIsEmpty("UA"));
  await upload("m2", [rcpt(40, "Uninit Alpha", 300, "UA1")], "ua-replace.xlsx");
  eq(await summary("UA"), { date: day(10), amount: 800 }, "previous newer payment (10 days ago) is retained; the replacement's older receipt (40 days ago) does not replace it");
  eq((await row("UA")).lastPaymentDate, day(10));
  eq(Number((await rpd("m2", "UA"))!.liveRecovery), 300, "Recovery still shows ITS upload's receipts for the month (unchanged rules)");
  // …when the previous payment lives only in the monthly snapshot column that the commit resets
  await mk("UB", "Snapshot Bravo");
  await prisma.recoveryPlanDealer.update({ where: { recoveryPlanId_dealerId: { recoveryPlanId: "rp-m1", dealerId: "UB" } }, data: { lastReceiptDate: new Date(`${day(12)}T00:00:00Z`), lastReceiptAmount: 123 } });
  await upload("m1", [rcpt(50, "Snapshot Bravo", 9, "UB1")], "ub.xlsx");
  eq(await summary("UB"), { date: day(12), amount: 123 }, "a payment known only from the (about to be reset) monthly snapshot is preserved first");
  eq([(await rpd("m1", "UB"))!.lastReceiptDate?.toISOString().slice(0, 10), Number((await rpd("m1", "UB"))!.lastReceiptAmount)], [day(50), 9], "…while Recovery's own Last Payment column follows its existing rule");

  // (1c) the retention step protects an uninitialized dealer ON ITS OWN too (e.g. a retried job, no pre-step): replacing the file must not lose the payment its source held
  await mk("UC", "Uninit Charlie");
  const ucFile = await legacyFile("uc", "m3", true); await legacyReceipt(ucFile.id, "UC", 10, 650, 1);
  const m3State = (await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlan: { seasonMonthId: "m3" } }, include: { recoveryPlan: true } })).map((r) => ({ planId: r.recoveryPlanId, dealerId: r.dealerId, receipt: Number(r.liveRecovery), srCr: Number(r.srCr), lastReceiptDate: r.lastReceiptDate, lastReceiptAmount: r.lastReceiptAmount == null ? null : Number(r.lastReceiptAmount) }));
  await historical.retainRegularReceipts(admin, Buffer.from("direct"), "uc.xlsx", "m3", [{ dealerId: "UC", date: new Date(`${day(40)}T00:00:00Z`), amount: 300, sourceOrder: 0 }], m3State);
  eq(await summary("UC"), { date: day(10), amount: 650 }, "the retention itself keeps the previous newer payment of a dealer inside the replacement");

  // (6) an INACTIVE dealer receives a payment: matched for Last Payment only (never created, never part of Recovery)
  const dealersBefore = await prisma.dealer.count();
  const idleBook = [rcpt(15, "Idle Dealer", 640, "I1")];
  const idleAnalysis = await recovery.analyzeDaybook(admin, book(idleBook), "idle.xlsx", { seasonMonthId: "m3" });
  assert.ok(idleAnalysis.skipped.some((x: { dealerName: string; reason: string }) => x.dealerName === "Idle Dealer" && /Inactive dealer/.test(x.reason)), "the preview reports it (not as an unknown alias)");
  const idleUp = await upload("m3", idleBook, "idle.xlsx");
  eq([idleUp.dealersUpdated, idleUp.lastPayment.status, idleUp.lastPayment.paymentOnlyDealers], [0, "COMPLETE", 1]);
  eq(await summary("I"), { date: day(15), amount: 640 }, "the inactive dealer's payment is recorded");
  eq([(await row("I")).lastPaymentDate, (await row("I")).status, await prisma.dealer.count(), await prisma.recoveryPlanDealer.count({ where: { dealerId: "I" } })], [day(15), "INACTIVE", dealersBefore, 0], "no dealer created, no Recovery row");
  // (7) a matched dealer WITHOUT a Recovery Plan this month (not assigned to a planned officer)
  await prisma.dealer.create({ data: { id: "NP", name: "NoPlan Delta" } });
  const noPlan = await upload("m3", [rcpt(20, "NoPlan Delta", 910, "NP1")], "noplan.xlsx");
  eq([noPlan.dealersUpdated, await summary("NP"), await prisma.recoveryPlanDealer.count({ where: { dealerId: "NP" } })], [0, { date: day(20), amount: 910 }, 0], "recorded for Last Payment; Recovery's eligibility is unchanged");
  // an unknown name stays an unknown name (no dealer is created)
  const unknown = await recovery.analyzeDaybook(admin, book([rcpt(5, "Totally Unknown Traders", 1, "U1")]), "unk.xlsx", { seasonMonthId: "m3" });
  assert.ok(unknown.skipped.some((x: { reason: string }) => /Unknown Alias/.test(x.reason)) && (await prisma.dealer.count({ where: { name: "Totally Unknown Traders" } })) === 0);

  // (8) a FUTURE-dated first receipt: stored, ineffective, survives its source being replaced and deactivated, effective later with no upload
  await mk("FD", "Future Charlie");
  await upload("m2", [rcpt(-5, "Future Charlie", 700, "FD1")], "fd.xlsx");
  eq([await ledgerCount("FD"), await summary("FD"), (await row("FD")).lastPaymentDate, (await row("FD")).days, (await row("FD")).billingStatus], [1, null, null, null, "UNAVAILABLE"], "stored, but not effective before its date (no negative Days, no premature Open)");
  await upload("m2", [rcpt(33, "Yash Stores", 1, "FDX")], "fd-replace.xlsx");
  await prisma.lastPaymentImport.updateMany({ data: { isActive: false } });
  eq([(await row("FD", day(-6))).lastPaymentDate, (await row("FD", day(-6))).amount, (await row("FD", day(-6))).days, (await row("FD", day(-5))).days, (await row("FD", day(-5))).billingStatus], [day(-5), 700, 1, 0, "OPEN"], "its day arrives: effective without another upload, although its import is long inactive");
  assert.equal(await summary("FD"), null, "the report read wrote nothing");
  await prisma.lastPaymentImport.updateMany({ data: { isActive: true } });

  // (9) Last Payment processing FAILS: Recovery stays committed, the payload is durable, the next upload (a "restarted" server) finishes it
  await mk("JF", "Job Fail"); await mk("JG", "Job Good");
  await block(4242);
  const failedUp = await upload("m2", [rcpt(6, "Job Fail", 4242, "J1")], "jf.xlsx");
  eq([failedUp.lastPayment.status, failedUp.receiptTotal], ["PENDING_RETRY", 4242]);
  assert.ok(/retried automatically/.test(failedUp.receiptHistoryWarning ?? "") && /injected/.test((failedUp.lastPayment.diagnostic ?? "")) && !/postgres(ql)?:\/\//i.test((failedUp.lastPayment.diagnostic ?? "")), "actionable warning + a credential-free diagnostic");
  const failedJob = await prisma.lastPaymentJob.findUniqueOrThrow({ where: { id: failedUp.lastPayment.jobId } });
  eq([failedJob.status, failedJob.attempts, (failedJob.payload as { paymentReceipts: unknown[] }).paymentReceipts.length], ["FAILED", 1, 1], "the resolved receipts are stored durably");
  eq([Number((await rpd("m2", "JF"))!.liveRecovery), await ledgerCount("JF")], [4242, 0], "Recovery committed; nothing half-written for Last Payment");
  await unblock();
  const freshRecovery = load<typeof import("@/features/recovery/service.server")>("src/features/recovery/service.server.ts"); // a "restarted" server: new module instances, same database
  const next = await freshRecovery.commitDaybook(admin, book([rcpt(4, "Job Good", 100, "J2")]), "jg.xlsx", { seasonMonthId: "m2" });
  eq(next.lastPayment.status, "COMPLETE");
  const healed = await prisma.lastPaymentJob.findUniqueOrThrow({ where: { id: failedUp.lastPayment.jobId } });
  eq([healed.status, healed.attempts, await summary("JF"), await summary("JG")], ["DONE", 2, { date: day(6), amount: 4242 }, { date: day(4), amount: 100 }], "another upload recovered the failed one from its stored payload");
  assert.equal(healed.outcome, "SUPERSEDED", "(the month had been replaced by the newer upload meanwhile, so only the permanent ledger was fed)");

  // (10) a DELAYED older retry never overwrites a newer payment, never reactivates its obsolete import, never touches Recovery's monthly state
  await mk("DX", "Delay Xray");
  await block(4243);
  const jobA = await upload("m3", [rcpt(30, "Delay Xray", 4243, "A1")], "da.xlsx");
  const jobB = await upload("m3", [rcpt(3, "Delay Xray", 90, "B1")], "db.xlsx");
  eq([jobA.lastPayment.status, jobB.lastPayment.status, await summary("DX")], ["PENDING_RETRY", "COMPLETE", { date: day(3), amount: 90 }], "the older upload failed; the newer one completed (and retrying A first did not block it)");
  await unblock();
  const monthState = async () => JSON.stringify((await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlan: { seasonMonthId: "m3" } }, orderBy: { id: "asc" }, select: { id: true, liveRecovery: true, srCr: true, lastReceiptDate: true, lastReceiptAmount: true } })));
  const recoveryBefore = await monthState();
  const importsBefore2 = JSON.stringify((await prisma.lastPaymentImport.findMany({ where: { scopeKey: "m3" }, orderBy: { id: "asc" }, select: { id: true, isActive: true } })));
  const [r1, r2] = await Promise.all([historical.processLastPaymentJob(jobA.lastPayment.jobId), historical.processLastPaymentJob(jobA.lastPayment.jobId)]);
  eq([r1.status, r2.status, r1.outcome ?? r2.outcome], ["DONE", "DONE", "SUPERSEDED"], "concurrent / repeated retries are idempotent");
  eq([await summary("DX"), await ledgerCount("DX"), await monthState() === recoveryBefore, JSON.stringify((await prisma.lastPaymentImport.findMany({ where: { scopeKey: "m3" }, orderBy: { id: "asc" }, select: { id: true, isActive: true } }))) === importsBefore2], [{ date: day(3), amount: 90 }, 2, true, true], "newer payment kept; the older receipt is in the ledger; Recovery's month and the active import untouched");
  assert.equal((await prisma.lastPaymentImport.findMany({ where: { scopeKey: "m3", isActive: true } })).map((i) => i.workbookName).join(), "db.xlsx");

  // (10b) same Recovery result, newer job already DONE: the older job must still not reactivate its obsolete import (rule, not the incidental "state changed" check)
  await mk("DY", "Delay Yankee");
  await block(4245);
  const oldJob = await upload("m1", [rcpt(20, "Delay Yankee", 500, "Y1"), rcpt(18, "Idle Dealer", 4245, "Y2")], "dy-old.xlsx");
  const newJob = await upload("m1", [rcpt(20, "Delay Yankee", 500, "Y1")], "dy-new.xlsx");
  eq([oldJob.lastPayment.status, newJob.lastPayment.status], ["PENDING_RETRY", "COMPLETE"]);
  await unblock();
  const outcome = await historical.processLastPaymentJob(oldJob.lastPayment.jobId);
  eq(outcome.outcome, "SUPERSEDED", "an older job never replaces a newer processed upload of its month");
  assert.equal((await prisma.lastPaymentImport.findMany({ where: { scopeKey: "m1", isActive: true } })).map((i) => i.workbookName).join(), "dy-new.xlsx", "the newer import stays active");
  assert.equal((await ledgerCount("I")) >= 1 && (await summary("I"))!.date === day(15), true, "…while the older upload's valid payment still reached the permanent ledger (latest stays the newer 15-days-ago one)");

  // (11) automatic recovery after a restart WITHOUT another upload: the first Last Payment Report read finishes the job in the background
  await mk("KK", "Kick Kilo");
  await block(4244);
  const kicked = await upload("m1", [rcpt(8, "Kick Kilo", 4244, "K1")], "kk.xlsx");
  eq(kicked.lastPayment.status, "PENDING_RETRY");
  await unblock();
  process.env.LAST_PAYMENT_JOB_KICK = "on";
  const freshReport = load<typeof import("@/features/reports/last-payment-report.server")>("src/features/reports/last-payment-report.server.ts");
  await freshReport.getLastPaymentReport(admin, params(), today);
  for (let i = 0; i < 50 && (await prisma.lastPaymentJob.findUniqueOrThrow({ where: { id: kicked.lastPayment.jobId } })).status !== "DONE"; i++) await new Promise((r) => setTimeout(r, 100));
  process.env.LAST_PAYMENT_JOB_KICK = "off";
  eq([(await prisma.lastPaymentJob.findUniqueOrThrow({ where: { id: kicked.lastPayment.jobId } })).status, await summary("KK")], ["DONE", { date: day(8), amount: 4244 }], "recovered automatically, no upload and no manual step");

  // Recovery's calculations are exactly what the existing rules give (one dealer, two receipts the same month: Live Recovery = their sum)
  await mk("RC", "Recov Calc");
  await upload("m1", [rcpt(9, "Recov Calc", 300, "RC1"), rcpt(7, "Recov Calc", 200, "RC2")], "rc.xlsx");
  const rc = (await rpd("m1", "RC"))!;
  eq([Number(rc.liveRecovery), Number(rc.srCr), rc.lastReceiptDate?.toISOString().slice(0, 10), Number(rc.lastReceiptAmount)], [500, 0, day(7), 200], "Live Recovery / SR-CR / month Last Payment column unchanged by Last Payment's own processing");

  console.log("dealer-last-payment.integration.ts — all assertions passed");
}
main().then(() => prisma.$disconnect(), async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
