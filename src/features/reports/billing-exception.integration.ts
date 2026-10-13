/**
 * Billing Exception against a REAL, disposable PostgreSQL database: row locks, unique indexes, rollback and the real Day Book commits are what the
 * concurrency / lifecycle guarantees rest on — an in-memory fake cannot prove them.
 *
 *   createdb billing_exception_test && DATABASE_URL=postgresql://localhost:5432/billing_exception_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   BILLING_EXCEPTION_TEST_URL=postgresql://localhost:5432/billing_exception_test npm run test:billing-exceptions:db
 *
 * Only a LOCAL database named `billing_exception_test` is permitted — the script TRUNCATEs the tables it uses.
 */
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";
import { currentBusinessDate } from "@/lib/daily-work";
import { parseLastPaymentReportParams } from "@/lib/last-payment-report";
import { acceptReceipts } from "@/lib/dealer-last-payment";
import type { AdminPermissions } from "@/features/accounts/permissions";

const url = process.env.BILLING_EXCEPTION_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/billing_exception_test")
  throw new Error("Only a local database named billing_exception_test is permitted (set BILLING_EXCEPTION_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
let failAuditFor: string | null = null;
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => { if (failAuditFor && data.entity === failAuditFor) throw new Error("injected audit failure"); return tx.auditLog.create({ data }); } },
  "@/features/cn-requests/service.server": { latestCnRequestStatusByDealer: async () => new Map() },
});
const be = load<typeof import("./billing-exception.server")>("src/features/reports/billing-exception.server.ts");
const report = load<typeof import("./last-payment-report.server")>("src/features/reports/last-payment-report.server.ts");
const historical = load<typeof import("@/features/historical-daybook/service.server")>("src/features/historical-daybook/service.server.ts");
const recovery = load<typeof import("@/features/recovery/service.server")>("src/features/recovery/service.server.ts");

const today = currentBusinessDate();
let asOf = today; // the business date the helpers evaluate at (advanced later to age a dealer — payments are persistent now, so deactivating an import no longer "un-pays" anyone)
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const ctx = (userId: string, role: Role, groupId: string | null, permissions?: AdminPermissions): AuthContext => ({ userId, username: userId, role, groupId, permissions }) as AuthContext;
// The services run in a separate VM realm: compare through JSON so arrays/objects from either realm are equal when their contents are.
const eq = (actual: unknown, expected: unknown, message?: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const params = (over: Record<string, unknown> = {}) => ({ ...parseLastPaymentReportParams(new URLSearchParams()), pageSize: 200, ...over });
let seq = 0;
const input = (dealerId: string, over: Record<string, unknown> = {}) => ({ dealerId, billingDate: daysAgo(1), billNo: `B-${++seq}`, authPerson: "Varun sir", requestId: `req-${seq}-${Math.random().toString(36).slice(2, 10)}`, billingAmount: 20000, paymentCondition: "NO", ...over });
const header = ["Date", "Particulars", "Vch Type", "Vch No.", "Credit Amount"];
function book(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), "Day Book");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const admin = ctx("admin", Role.SUPER_ADMIN, null);
const so1 = ctx("so1", Role.SALES_OFFICER, "g1"), so2 = ctx("so2", Role.SALES_OFFICER, "g1"), rm = ctx("rm", Role.REGIONAL_MANAGER, "g1"), so3 = ctx("so3", Role.SALES_OFFICER, "g2");

async function receipt(dealerId: string, daysBack: number, amount = 1000, kind = "REGULAR", scopeKey = "") {
  const batch = await prisma.lastPaymentImport.create({ data: { kind, scopeKey, fileHash: `h-${dealerId}-${daysBack}-${Math.random()}`, workbookName: "seed.xlsx", uploadedById: "admin", summary: "{}" } });
  await prisma.lastPaymentReceipt.create({ data: { importId: batch.id, dealerId, rowKey: "r1", sourceOrder: 1, receiptDate: new Date(`${daysAgo(daysBack)}T00:00:00Z`), creditAmount: amount } });
  // …and the persistent latest payment, exactly as the Day Book commits do (the report reads that, not the import's active flag)
  await acceptReceipts(prisma, [{ dealerId, date: daysAgo(daysBack), amount, sourceOrder: 1 }], { sourceKind: kind, importId: batch.id }, today);
  return batch;
}
async function dealer(id: string, name: string, owner: string, daysBack: number | null) {
  await prisma.dealer.create({ data: { id, name } });
  await prisma.dealerAssignment.create({ data: { dealerId: id, officerId: owner, effectiveFrom: new Date("2024-01-01") } });
  if (daysBack !== null) await receipt(id, daysBack);
}
const reportRow = async (c: AuthContext, dealerId: string) => (await report.getLastPaymentReport(c, params(), asOf)).items.find((r) => r.dealerId === dealerId)!;
const current = (c: AuthContext, over = {}) => be.listBillingExceptions(c, "current", params(over), asOf);
const history = (c: AuthContext, over = {}) => be.listBillingExceptions(c, "history", params(over), asOf);
const currentCount = (dealerId: string) => prisma.billingException.count({ where: { dealerId, status: "CURRENT" } });

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "BillingException","LastPaymentReceipt","LastPaymentImport","RecoveryPlanDealer","RecoveryPlan","SeasonMonth","Season","DealerAssignment","Dealer","AuditLog","User","UserGroup" CASCADE`);
  for (const g of ["g1", "g2"]) await prisma.userGroup.create({ data: { id: g, name: `State ${g}` } });
  const mk = (id: string, role: Role, groupId: string | null) => prisma.user.create({ data: { id, name: id.toUpperCase(), username: id, passwordHash: "x", role, groupId, territory: `T-${id}` } });
  await mk("admin", Role.SUPER_ADMIN, null); await mk("rm", Role.REGIONAL_MANAGER, "g1"); await mk("so1", Role.SALES_OFFICER, "g1"); await mk("so2", Role.SALES_OFFICER, "g1"); await mk("so3", Role.SALES_OFFICER, "g2"); await mk("ca2", Role.CUSTOM_ADMIN, null);
  await dealer("dA", "Alpha Traders", "so1", 50); await dealer("dB", "Beta Stores", "so1", 60); await dealer("dC", "Gamma Agro", "so2", 70);
  await dealer("dFresh", "Fresh Dealer", "so1", 10); await dealer("dNone", "Never Paid", "so1", null);
  await dealer("d45", "Boundary 45", "so1", 45); await dealer("d46", "Boundary 46", "so1", 46);

  /* ---- 1. Billing Status from the report's own Days (boundaries, missing payment) ---- */
  eq(await Promise.all(["dA", "dFresh", "dNone", "d45", "d46"].map(async (id) => (await reportRow(admin, id)).billingStatus)), ["BLOCKED", "OPEN", "UNAVAILABLE", "OPEN", "BLOCKED"], "50 → Blocked, 10 → Open, no payment → Unavailable (never 0/Open), exactly 45 → Open, 46 → Blocked");
  assert.equal((await reportRow(admin, "dNone")).days, null, "missing Days stays null");

  /* ---- 2. validation, permissions, scope ---- */
  for (const bad of [{ authPerson: "Someone" }, { authPerson: "" }, { billNo: "   " }, { billingDate: "" }, { billingDate: "2026-02-31" }, { billingDate: "31/01/2026" }, { requestId: "" }, { dealerId: "" }])
    assert.equal(await code(be.createBillingException(admin, input("dA", bad), asOf)), 422, `invalid input refused: ${JSON.stringify(bad)}`);
  assert.equal(await code(be.createBillingException(ctx("ca", Role.CUSTOM_ADMIN, null, { lastPaymentReport: ["read", "export"] }), input("dA"), asOf)), 403, "a read/export grant does not allow creation");
  for (const who of [so1, so2, so3, rm]) assert.equal(await code(be.createBillingException(who, input("dA"), asOf)), 403, `${who.role} ${who.userId}: never allowed to create`);
  assert.equal(await code(be.createBillingException(admin, input("dFresh"), asOf)), 409, "an Open dealer (Days ≤ 45) cannot get an exception");
  assert.equal(await code(be.createBillingException(admin, input("d45"), asOf)), 409, "exactly 45 is Open");
  assert.equal(await code(be.createBillingException(admin, input("dNone"), asOf)), 409, "no payment date → not applicable");
  assert.equal(await code(be.createBillingException(admin, input("nope"), asOf)), 404);
  assert.equal(await prisma.billingException.count(), 0, "every refused request wrote nothing");

  /* ---- 3. create, snapshot, duplicates, multiple exceptions ---- */
  const inA = input("dA");
  const a = await be.createBillingException(admin, { ...inA, days: 3, snapDays: 3, status: "RESOLVED", ownerId: "so2" }, asOf); // client-supplied Days / lifecycle / owner are ignored
  eq([a.snapshot.days, a.snapshot.lastPaymentDate, a.snapshot.amount, a.exceptionStatus, a.duplicate, a.createdByName], [50, daysAgo(50), 1000, "CURRENT", false, "ADMIN"]);
  const again = await be.createBillingException(admin, inA, asOf);
  eq([again.id, again.duplicate], [a.id, true], "re-delivery of the same Save returns the original");
  assert.equal(await code(be.createBillingException(admin, { ...inA, billNo: "DIFFERENT" }, asOf)), 409, "a reused request identity with other content is refused");
  assert.equal(await prisma.billingException.count({ where: { dealerId: "dA" } }), 1);
  assert.equal((await reportRow(admin, "dA")).billingStatus, "BILLING_EXCEPTION", "the dealer is now purple");
  const b = await be.createBillingException(admin, input("dA", { billNo: inA.billNo }), asOf); // same Bill No on purpose: not globally unique
  assert.notEqual(b.id, a.id);
  assert.equal((await reportRow(admin, "dA")).currentExceptions, 2);
  const cur = await current(admin);
  eq(cur.items.map((r) => r.exceptionId).sort(), [a.id, b.id].sort(), "Current: one row per EXCEPTION");
  assert.ok(cur.items.every((r) => r.dealerId === "dA" && r.days === 50 && r.party === "Alpha Traders"));
  assert.equal(cur.total, 2, "paginated and counted by exception, not by dealer");
  assert.equal((await history(admin)).total, 2, "History holds every exception immediately, including current ones");
  assert.equal((await be.getBillingExceptionDetail(so1, b.id)).id, b.id, "Info shows the exact exception");
  assert.equal(await code(be.getBillingExceptionDetail(so2, a.id)), 404, "another officer's exception looks missing");
  assert.equal((await be.getBillingExceptionDetail(rm, a.id)).createdByName, "ADMIN", "RM may READ the exception (Info) of a dealer in scope");
  eq([(await current(so2)).total, (await current(so1)).total, (await current(rm)).total, (await current(so3)).total], [0, 2, 2, 0], "scope follows the dealer's CURRENT owner");
  eq((await current(admin, { search: "alpha" })).items.length, 2);
  eq((await current(admin, { filters: { state: ["State g2"] } })).items.length, 0);
  assert.equal(await code(be.createBillingException(ctx("ca2", Role.CUSTOM_ADMIN, null, { lastPaymentReport: ["read", "create"] }), input("dB"), asOf)), 0, "a Custom Admin with the create grant may record one");
  assert.equal(await prisma.auditLog.count({ where: { entity: "billingException", action: "CREATE" } }), 3, "audit: one entry per created exception, none for the duplicate");

  /* ---- 4. concurrency: identical requests, deliberate new requests ---- */
  const same = input("dC");
  const res = await Promise.all(Array.from({ length: 6 }, () => code(be.createBillingException(admin, same, asOf))));
  eq(res, [0, 0, 0, 0, 0, 0], "every delivery succeeds (re-deliveries return the original)");
  assert.equal(await prisma.billingException.count({ where: { dealerId: "dC" } }), 1, "ONE row for six deliveries of one Save");
  const distinct = await Promise.all(Array.from({ length: 5 }, () => code(be.createBillingException(admin, input("dC"), asOf))));
  eq(distinct, [0, 0, 0, 0, 0]);
  assert.equal(await prisma.billingException.count({ where: { dealerId: "dC" } }), 6, "five deliberate new exceptions are all kept");

  /* ---- 5. race: Save versus a payment commit + reconciliation (never an invalid CURRENT exception) ---- */
  for (let round = 1; round <= 8; round++) {
    const id = `race${round}`;
    await dealer(id, `Race Dealer ${round}`, "so1", 80);
    const saveP = code(be.createBillingException(admin, input(id), asOf));
    const payP = (async () => { await receipt(id, 5, 500, "HISTORICAL"); return be.reconcileBillingExceptions({ today: asOf, actor: { userId: "admin" } }); })();
    const [saved] = await Promise.all([saveP, payP]);
    assert.ok([0, 409].includes(saved), `round ${round}: the Save either won or was rejected as stale (${saved})`);
    assert.equal(await currentCount(id), 0, `round ${round}: no CURRENT exception survives for a dealer whose committed Days are 5`);
    const rows = await prisma.billingException.findMany({ where: { dealerId: id } });
    assert.ok(rows.every((r) => r.status === "RESOLVED" && r.snapDays === 80), `round ${round}: a winning Save is resolved with its snapshot intact`);
  }

  /* ---- 6. real historical Day Book: payment brings Days to 23 → ALL current exceptions resolve, History keeps the snapshots ---- */
  const beforeSnap = await prisma.billingException.findMany({ where: { dealerId: "dA" }, orderBy: { id: "asc" } });
  const histBefore = await prisma.lastPaymentImport.count({ where: { kind: "HISTORICAL" } });
  const hbook = book([[daysAgo(23), "Alpha Traders", "Receipt", "H-1", 7000]]);
  const preview = await historical.analyzeHistoricalDaybook(admin, hbook, "h.xlsx", {});
  failAuditFor = "billingException"; // reconciliation fails once…
  const warned = await historical.commitHistoricalDaybook(admin, hbook, "h.xlsx", { reviews: [], previewToken: preview.previewToken, confirmed: true });
  failAuditFor = null;
  assert.ok(warned.imported === 1 && warned.billingExceptionWarning, "the receipt commit succeeded; only a WARNING reports the failed re-check");
  assert.equal(await prisma.lastPaymentImport.count({ where: { kind: "HISTORICAL" } }), histBefore + 1, "…and the financial commit was kept (not undone) and not replayed");
  assert.equal(await currentCount("dA"), 2, "failed reconciliation left the rows CURRENT (stored)");
  assert.equal((await reportRow(admin, "dA")).billingStatus, "OPEN", "…but the report is already correct (Days 23 → Open, derived at read time)");
  assert.equal((await current(admin)).items.filter((r) => r.dealerId === "dA").length, 0, "…and Current hides them (read-time guard)");
  const retry = await historical.commitHistoricalDaybook(admin, hbook, "h.xlsx", { reviews: [], previewToken: preview.previewToken, confirmed: true });
  assert.ok(retry.alreadyImported && !retry.billingExceptionWarning, "re-uploading the same file is a no-op for receipts but retries the reconciliation");
  assert.equal(await currentCount("dA"), 0, "both exceptions are now resolved");
  const afterSnap = await prisma.billingException.findMany({ where: { dealerId: "dA" }, orderBy: { id: "asc" } });
  eq(afterSnap.map((r) => [r.status, r.resolutionReason, r.resolvedDays]), [["RESOLVED", "PAYMENT_RECEIVED", 23], ["RESOLVED", "PAYMENT_RECEIVED", 23]]);
  eq(afterSnap.map((r) => [r.snapDays, r.snapLastPaymentDate?.toISOString(), String(r.snapAmount), r.snapParty]), beforeSnap.map((r) => [r.snapDays, r.snapLastPaymentDate?.toISOString(), String(r.snapAmount), r.snapParty]), "creation snapshots are unchanged");
  const hist = await history(admin);
  eq(hist.items.filter((r) => r.dealerId === "dA").map((r) => [r.days, r.exceptionStatus]), [[50, "RESOLVED"], [50, "RESOLVED"]], "History keeps the ORIGINAL Days (50), not today's 23");
  assert.equal((await be.getBillingExceptionDetail(so1, a.id)).resolvedDays, 23);
  const idem = await be.reconcileBillingExceptions({ today: asOf, actor: { userId: "admin" } });
  assert.equal(idem.resolved, 0, "reconciliation is idempotent");

  /* ---- 7. later ageing does not reactivate; a deliberate new exception is possible ---- */
  await prisma.lastPaymentImport.updateMany({ where: { kind: "HISTORICAL", workbookName: "h.xlsx" }, data: { isActive: false } });
  assert.equal((await reportRow(admin, "dA")).days, 23, "deactivating the import does NOT un-pay the dealer: the accepted payment is persistent");
  asOf = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10); // …ageing happens with time: 30 days later the dealer is above 45 again (23 + 30 = 53)
  assert.equal((await reportRow(admin, "dA")).billingStatus, "BLOCKED", "above 45 again: Blocked until a NEW exception exists (old ones stay resolved)");
  assert.equal((await current(admin)).items.filter((r) => r.dealerId === "dA").length, 0);
  const c = await be.createBillingException(admin, input("dA"), asOf);
  assert.equal((await reportRow(admin, "dA")).billingStatus, "BILLING_EXCEPTION");
  assert.equal((await history(admin)).items.filter((r) => r.dealerId === "dA").length, 3);
  assert.ok(c.id);

  /* ---- 8. History is a snapshot: master-data changes do not rewrite it (Current stays live) ---- */
  await prisma.dealer.update({ where: { id: "dA" }, data: { name: "Alpha RENAMED", status: "DEFAULTER" } });
  await prisma.dealerAssignment.updateMany({ where: { dealerId: "dA" }, data: { effectiveTo: new Date() } });
  await prisma.dealerAssignment.create({ data: { dealerId: "dA", officerId: "so3", effectiveFrom: new Date() } });
  const h2 = (await history(admin)).items.find((r) => r.exceptionId === a.id)!;
  eq([h2.party, h2.status, h2.salesOfficer, h2.days], ["Alpha Traders", "ACTIVE", "SO1", 50], "History shows the stored context");
  const c2 = (await current(admin)).items.find((r) => r.exceptionId === c.id)!;
  eq([c2.party, c2.status, c2.salesOfficer], ["Alpha RENAMED", "DEFAULTER", "SO3"], "Current follows live master data");
  assert.equal((await history(so1)).items.filter((r) => r.dealerId === "dA").length, 0, "access follows the CURRENT owner: the old owner loses the history, the snapshot's owner column does not grant access");
  assert.equal((await history(so3)).items.filter((r) => r.dealerId === "dA").length, 3);
  assert.equal(await code(be.getBillingExceptionDetail(so1, a.id)), 404);

  /* ---- 8b. a later payment resolves ONLY the current exception; earlier resolutions keep their own lifecycle metadata ---- */
  await receipt("dA", 10, 400, "HISTORICAL");
  const r8 = await be.reconcileBillingExceptions({ today: asOf, actor: { userId: "admin" } });
  assert.equal(r8.resolved, 1, "only the CURRENT exception (c) was resolved");
  eq((await prisma.billingException.findMany({ where: { dealerId: "dA" }, orderBy: { createdAt: "asc" } })).map((r) => [r.status, r.resolvedDays]), [["RESOLVED", 23], ["RESOLVED", 23], ["RESOLVED", 40]], "earlier resolutions are untouched");

  /* ---- 9. regular Day Book (real commitDaybook): reconciliation covers dealers independent of the uploader's view ---- */
  await prisma.season.create({ data: { id: "s", name: "Rabi", year: 2026, startMonth: 4, startYear: 2026 } });
  const m = new Date(`${today}T00:00:00Z`);
  await prisma.seasonMonth.create({ data: { id: "sm", seasonId: "s", name: "This month", order: 1, calendarMonth: m.getUTCMonth() + 1, calendarYear: m.getUTCFullYear() } });
  await prisma.recoveryPlan.create({ data: { id: "rp", seasonId: "s", seasonMonthId: "sm", officerId: "so1", cutoffDate: new Date(`${today}T00:00:00Z`), status: "APPROVED", dealers: { create: [{ dealerId: "dB", outstanding: 100 }] } } });
  const bEx = await be.createBillingException(admin, input("dB"), asOf);
  assert.equal((await reportRow(admin, "dB")).days, 90, "60 days old + the 30 days the helpers have aged");
  const regular = await recovery.commitDaybook(admin, book([[today, "Beta Stores", "Receipt", "R-1", 9000]]), "regular.xlsx", { seasonMonthId: "sm" });
  assert.ok(!regular.billingExceptionWarning);
  assert.equal(await currentCount("dB"), 0, "the regular Day Book payment resolved dB's exception");
  assert.equal((await prisma.billingException.findUniqueOrThrow({ where: { id: bEx.id } })).snapDays, 90, "the snapshot keeps the Days at creation");
  assert.equal((await reportRow(admin, "dB")).billingStatus, "OPEN");

  /* ---- 10. no deletion cascade ---- */
  await assert.rejects(prisma.dealer.delete({ where: { id: "dA" } }), "a dealer with exception history cannot be deleted away");
  assert.ok(await prisma.billingException.count() >= 3);

  /* ---- 11. exports are the full filtered result ---- */
  assert.equal((await be.listBillingExceptionsExport(admin, "history", params({ pageSize: 1 }), asOf)).rows.length, (await history(admin)).total, "export ignores paging");

  /* ---- 12. Authorized By header filter: each exception judged on ITS OWN saved Auth Person, before paging, in Current and History, and in the export ---- */
  await dealer("dZ", "Zulu Auth", "so1", 55);
  const zV = await be.createBillingException(admin, input("dZ", { authPerson: "Varun sir" }), asOf);
  const zT1 = await be.createBillingException(admin, input("dZ", { authPerson: "Tej Sir" }), asOf);
  const zT2 = await be.createBillingException(admin, input("dZ", { authPerson: "Tej Sir" }), asOf);
  const idsOf = (rows: { exceptionId: string }[]) => rows.map((r) => r.exceptionId).sort();
  for (const view of ["current", "history"] as const) {
    const list = (over: Record<string, unknown> = {}) => be.listBillingExceptions(admin, view, params(over), asOf);
    const zOnly = (over: Record<string, unknown> = {}) => list({ search: "zulu", ...over });
    eq(idsOf((await zOnly({ filters: { authBy: ["Varun sir"] } })).items), [zV.id], `${view}: Varun sir only`);
    eq(idsOf((await zOnly({ filters: { authBy: ["Tej Sir"] } })).items), idsOf([{ exceptionId: zT1.id }, { exceptionId: zT2.id }]), `${view}: Tej Sir only — two separate rows of one dealer`);
    eq((await zOnly({ filters: { authBy: ["Varun sir", "Tej Sir"] } })).total, 3, `${view}: both options`);
    eq((await zOnly({ filters: {} })).total, 3, `${view}: cleared → everything`);
    assert.equal((await list({ filters: { authBy: ["Tej Sir"] } })).items.every((r: { authPerson: string }) => r.authPerson === "Tej Sir"), true);
    // before pagination: totals and page counts follow the filter; every page holds only that option
    const p1 = await zOnly({ pageSize: 1, page: 1, filters: { authBy: ["Tej Sir"] } }), p2 = await zOnly({ pageSize: 1, page: 2, filters: { authBy: ["Tej Sir"] } });
    eq([p1.total, p1.totalPages, p1.items.length, p2.items.length, p1.items[0]!.exceptionId !== p2.items[0]!.exceptionId], [2, 2, 1, 1, true], `${view}: totals / pages describe the filtered set`);
    // combined: search, Payment Aging, other column filters
    eq((await list({ search: "alpha", filters: { authBy: ["Tej Sir"] } })).items.filter((r: { party: string }) => r.party !== "Alpha Traders").length, 0, `${view}: combined with search`);
    eq((await zOnly({ filters: { authBy: ["Tej Sir"], state: ["State g2"] } })).total, 0, `${view}: combined with a column filter`);
    const zDays = (await zOnly({ filters: { authBy: ["Tej Sir"] } })).items[0]!.days as number;
    eq([(await zOnly({ filters: { authBy: ["Tej Sir"] }, paymentAging: { operator: "gt", value: zDays - 1 } })).total, (await zOnly({ filters: { authBy: ["Tej Sir"] }, paymentAging: { operator: "gt", value: zDays } })).total], [2, 0], `${view}: combined with Payment Aging`);
    assert.equal((await list({ filters: { authBy: ["nobody"] } })).total, 0, `${view}: an unknown value matches nothing`);
    const exported = (await be.listBillingExceptionsExport(admin, view, params({ pageSize: 1, search: "zulu", filters: { authBy: ["Tej Sir"] } }), asOf)).rows;
    eq(idsOf(exported), idsOf([{ exceptionId: zT1.id }, { exceptionId: zT2.id }]), `${view}: the export is the full filtered result`);
    assert.equal((await be.listBillingExceptions(so1, view, params({ filters: { authBy: ["Tej Sir"] } }), asOf)).items.every((r: { dealerId: string }) => ["dA", "dB", "dC", "dZ"].includes(r.dealerId)), true, `${view}: scope unchanged`);
  }
  // the filter belongs to the exception tabs: the Last Payment report ignores it (every dealer still listed)
  eq((await report.getLastPaymentReport(admin, params({ filters: { authBy: ["Tej Sir"] } }), asOf)).total, (await report.getLastPaymentReport(admin, params(), asOf)).total, "Last Payment tab: not applied");
  // a RESOLVED exception stays in History and is filtered by its own saved option
  await prisma.billingException.update({ where: { id: zV.id }, data: { status: "RESOLVED", resolvedAt: new Date(), resolutionReason: "PAYMENT_RECEIVED", resolvedDays: 3 } });
  eq([(await be.listBillingExceptions(admin, "current", params({ search: "zulu", filters: { authBy: ["Varun sir"] } }), asOf)).total, (await be.listBillingExceptions(admin, "history", params({ search: "zulu", filters: { authBy: ["Varun sir"] } }), asOf)).total], [0, 1], "resolved: gone from Current, kept in History");

  /* ---- 13. summary panel: computed on the server over the COMPLETE filtered set, per section ---- */
  type Sum = Awaited<ReturnType<typeof current>>["summary"];
  const entryOf = (r: { id: string; name: string; bills: number; amount: number; incomplete: boolean }) => [r.id, r.bills, r.amount, r.incomplete];
  // the verified shape: one dealer, two exceptions (₹23,000 + ₹12,000), one Sales Officer
  await dealer("dV", "test_dealer5", "so1", 70);
  await be.createBillingException(admin, input("dV", { billingAmount: 23000 }), asOf);
  await be.createBillingException(admin, input("dV", { billingAmount: 12000 }), asOf);
  for (const list of [current, history]) {
    const only = await list(admin, { search: "test_dealer5" });
    const sm = only.summary as Sum;
    eq([sm.totalBills, sm.dealers, sm.topDealers.byBills.map(entryOf), sm.topOfficers.byBills.map(entryOf)], [2, 1, [["dV", 2, 35000, false]], [["so1", 2, 35000, false]]], "test_dealer5: 2 bills, 1 dealer, ₹35,000 for the dealer and for its Sales Officer");
  }
  // totals are pagination-independent and equal the table total; Current and History each use their own section's data
  for (const view of ["current", "history"] as const) {
    const list = (over: Record<string, unknown> = {}) => be.listBillingExceptions(admin, view, params(over), asOf);
    const full = await list({ pageSize: 200 }), paged = await list({ pageSize: 1, page: 2 });
    eq([paged.summary.totalBills, paged.summary.totalBills === full.total, JSON.stringify(paged.summary) === JSON.stringify(full.summary)], [full.total, true, true], `${view}: summary independent of paging`);
    eq(full.summary.dealers, new Set(full.items.map((r: { dealerId: string }) => r.dealerId)).size, `${view}: unique dealer ids`);
  }
  // a RESOLVED exception is History-only: Current and History differ
  await prisma.billingException.updateMany({ where: { dealerId: "dV", billingAmount: 12000 }, data: { status: "RESOLVED", resolvedAt: new Date(), resolutionReason: "PAYMENT_RECEIVED", resolvedDays: 3 } });
  const cV = (await current(admin, { search: "test_dealer5" })).summary as Sum, hV = (await history(admin, { search: "test_dealer5" })).summary as Sum;
  eq([cV.totalBills, cV.topDealers.byBills[0]!.amount, hV.totalBills, hV.topDealers.byBills[0]!.amount], [1, 23000, 2, 35000], "Current counts only current exceptions; History counts every exception");
  // filters: Authorized By, search, column filter, access scope — all narrow the summary
  const tejOnly = (await history(admin, { search: "zulu", filters: { authBy: ["Tej Sir"] } })).summary as Sum;
  eq([tejOnly.totalBills, tejOnly.dealers], [2, 1], "Authorized By narrows the summary (zulu: 2 Tej Sir exceptions)");
  eq(((await current(admin, { filters: { state: ["State g2"] } })).summary as Sum).totalBills, 0, "a column filter narrows it (empty state: zeros, no entries)");
  eq(((await current(admin, { filters: { state: ["State g2"] } })).summary as Sum).topDealers.byBills.length, 0);
  const so2Sum = (await current(so2)).summary as Sum;
  assert.ok(so2Sum.topDealers.byBills.every((e) => e.id === "dC") && so2Sum.topOfficers.byBills.every((e) => e.id === "so2"), "access scope: an SO's summary covers only their own dealers");
  eq(((await current(so3)).summary as Sum).totalBills, 0, "another SO sees nothing");
  // legacy exceptions without a Billing Amount: counted as bills, never as invented money, flagged incomplete
  await dealer("dL", "Legacy Amounts", "so2", 66);
  const mkLegacy = (n: number, amt: number | null) => prisma.billingException.create({ data: { dealerId: "dL", billingDate: new Date(`${daysAgo(2)}T00:00:00Z`), billNo: `LG-${n}`, authPerson: "Varun sir", createdById: "admin", requestId: `legacy-req-0000${n}`, snapDays: 66, snapLastPaymentDate: new Date(`${daysAgo(66)}T00:00:00Z`), snapAmount: 100, snapParty: "Legacy Amounts", snapDealerStatus: "ACTIVE", snapSalesOfficer: "SO2", snapSalesOfficerId: "so2", billingAmount: amt } });
  await mkLegacy(1, null); await mkLegacy(2, 500);
  for (const list of [current, history]) {
    const l = ((await list(admin, { search: "legacy amounts" })).summary as Sum);
    eq([l.totalBills, l.amountsIncomplete, l.topDealers.byBills.map(entryOf)], [2, true, [["dL", 2, 500, true]]], "missing amounts: excluded from the sum, flagged incomplete");
  }
  // an exception whose dealer has no assigned Sales Officer: in the totals, not in the SO ranking
  await prisma.dealer.create({ data: { id: "dN", name: "No Officer Dealer" } }); await receipt("dN", 80);
  await be.createBillingException(admin, input("dN", { billingAmount: 777 }), asOf);
  for (const list of [current, history]) {
    const n = (await list(admin, { search: "no officer" })).summary as Sum;
    eq([n.totalBills, n.dealers, n.topDealers.byBills.map(entryOf), n.topOfficers.byBills.length], [1, 1, [["dN", 1, 777, false]], 0], "no assigned SO: counted overall, left out of the officer ranking");
  }
  // rankings are recomputed per metric from the whole set (not a re-sort of one top-five)
  const all = (await current(admin)).summary as Sum;
  assert.ok(all.topDealers.byBills.length <= 5 && all.topOfficers.byBills.length <= 3);
  const maxAmount = Math.max(...(await current(admin, { pageSize: 200 })).items.reduce((m: Map<string, number>, r: { dealerId: string; billingAmount: number | null }) => m.set(r.dealerId, (m.get(r.dealerId) ?? 0) + (r.billingAmount ?? 0)), new Map<string, number>()).values());
  eq(all.topDealers.byAmount[0]!.amount, maxAmount, "by amount: the first entry holds the largest summed Billing Amount");
  // the summary never touches the table rows or the exception records
  eq((await current(admin, { pageSize: 200 })).items.length, (await current(admin, { pageSize: 200 })).total);

  /* ---- 14. Payment (promised recovery amount): separate storage, one task per exception, DB constraint, legacy rows untouched ---- */
  await dealer("dP", "Payment Dealer", "so1", 61);
  const payOn = new Date(Date.parse(`${asOf}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const yesIn = input("dP", { billingAmount: 50000, paymentAmount: 15000, paymentCondition: "YES", paymentDate: new Date(Date.parse(`${asOf}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10) });
  const settled = await Promise.all(Array.from({ length: 5 }, () => code(be.createBillingException(admin, yesIn, asOf))));
  eq(settled, [0, 0, 0, 0, 0], "five deliveries of one Save (double click / retries)");
  const pRows = await prisma.billingException.findMany({ where: { dealerId: "dP" }, include: { task: true } });
  eq([pRows.length, pRows[0]!.task ? 1 : 0, Number(pRows[0]!.billingAmount), Number(pRows[0]!.paymentAmount), Number(pRows[0]!.task!.amount)], [1, 1, 50000, 15000, 15000], "one exception, ONE task; Amount 50,000 / Payment 15,000 stored separately; the task is planned for the Payment");
  assert.equal(await code(be.createBillingException(admin, { ...yesIn, paymentAmount: 15001 }, asOf)), 409, "a reused request id with another Payment is refused");
  assert.equal(await code(be.createBillingException(admin, input("dP", { paymentCondition: "YES", paymentDate: payOn }), asOf)), 422, "Yes without a Payment is refused (not defaulted from Amount)");
  const noIn = await be.createBillingException(admin, input("dP", { paymentCondition: "NO", paymentDate: payOn, paymentAmount: 999 }), asOf);
  eq([noIn.paymentAmount, noIn.paymentDate, noIn.task], [null, null, null], "No: hidden date / Payment cleared, no task (Yes → No cannot create one)");
  assert.equal(await prisma.billingExceptionTask.count({ where: { dealerId: "dP" } }), 1);
  await assert.rejects(prisma.$executeRaw`UPDATE "BillingException" SET "paymentAmount" = 5 WHERE "id" = ${noIn.id}`, "the database refuses a promised amount on a No");
  await assert.rejects(prisma.$executeRaw`UPDATE "BillingException" SET "paymentAmount" = 0 WHERE "id" = ${pRows[0]!.id}`, "…and a non-positive one");
  // legacy rows (no paymentAmount) stay readable and untouched; their detail shows none, and nothing is regenerated
  const legacyYes = await prisma.billingException.create({ data: { dealerId: "dP", billingDate: new Date(`${daysAgo(3)}T00:00:00Z`), billNo: "LEG", authPerson: "Tej Sir", createdById: "admin", requestId: "legacy-payment-0001", snapDays: 61, snapParty: "Payment Dealer", snapDealerStatus: "ACTIVE", billingAmount: 777, paymentCondition: true, paymentDate: new Date(`${payOn}T00:00:00Z`) } });
  const legacyDetail = await be.getBillingExceptionDetail(admin, legacyYes.id);
  eq([legacyDetail.billingAmount, legacyDetail.paymentAmount, legacyDetail.task], [777, null, null], "legacy Yes exception: no promised amount invented, no task");
  assert.equal(await prisma.billingExceptionTask.count({ where: { dealerId: "dP" } }), 1, "no task regenerated");
  // the summary / rankings keep using the BILLING amount
  const ps = ((await be.listBillingExceptions(admin, "current", params({ search: "payment dealer" }), asOf)).summary);
  eq(ps.topDealers.byBills[0]!.amount, 50000 + 777 + 20000, "exception amount rankings use Amount, never Payment");
  console.log("billing-exception.integration.ts — all assertions passed");
}
main().then(() => prisma.$disconnect(), async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
