/**
 * Daily Plan draft saves (Sales / Recovery with Visit follow-ups, Relationship visits, the derived Dealer Visits) against a REAL, disposable PostgreSQL database with SIMULATED NETWORK LATENCY (every statement waits a fixed round trip first). The
 * database itself needs milliseconds; what exhausts Prisma's interactive-transaction budget is the number of sequential round trips, so this suite counts them.
 *
 *   createdb save_draft_test && DATABASE_URL=postgresql://localhost:5432/save_draft_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   SAVE_DRAFT_TEST_URL=postgresql://localhost:5432/save_draft_test npm run test:save-draft:db
 *
 * Only a LOCAL database named `save_draft_test` is permitted — the script TRUNCATEs the tables it uses. The client has ONE pooled connection: any statement issued on the global client
 * while a transaction is open (a stale / wrong client) would wait for that connection and fail, so passing proves every helper uses the active transaction client.
 */
import assert from "node:assert/strict";
import { Prisma, PrismaClient, Role } from "@prisma/client";
import * as realDailyWork from "@/lib/daily-work";
import * as realLabels from "@/features/labels/labels";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

const raw = process.env.SAVE_DRAFT_TEST_URL;
if (!raw || !["localhost", "127.0.0.1"].includes(new URL(raw).hostname) || new URL(raw).pathname !== "/save_draft_test")
  throw new Error("Only a local database named save_draft_test is permitted (set SAVE_DRAFT_TEST_URL).");
const withPool = (u: string) => { const x = new URL(u); x.searchParams.set("connection_limit", "1"); x.searchParams.set("pool_timeout", "3"); return x.toString(); };
let rtt = 0;
const base = new PrismaClient({ datasources: { db: { url: withPool(raw) } }, log: [{ emit: "event", level: "query" }] });
const queries: string[] = [];
base.$on("query", (e: { query: string }) => { queries.push(e.query.replace(/\s+/g, " ").trim()); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prisma = base.$extends({ query: { async $allOperations({ args, query }) { if (rtt) await sleep(rtt); return query(args); } } }) as unknown as PrismaClient;
const BASE_DAY = "2026-10-14";
const clock = BASE_DAY;
realDailyWork.dailyWorkClock.now = () => new Date(`${BASE_DAY}T06:00:00Z`); // 11:30 IST
const DL = realLabels.DEFAULT_LABELS as Record<string, string>;
const mocks = {
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (d: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => tx.auditLog.create({ data: d }) },
  "@/lib/daily-work": { ...realDailyWork, currentBusinessDate: (d?: Date) => (d ? realDailyWork.currentBusinessDate(d) : clock) },
  "@/lib/scope": { getCurrentOwnerByDealer: async (ids: string[], db: PrismaClient = base) => { const rows = await db.dealerAssignment.findMany({ where: { dealerId: { in: ids }, effectiveTo: null } }); return new Map(rows.map((r) => [r.dealerId, r.officerId])); }, getCurrentDealerIds: async (id: string) => (await base.dealerAssignment.findMany({ where: { officerId: id } })).map((a) => a.dealerId), getOfficerScope: async (c: AuthContext) => ({ all: false, ids: [c.userId] }), assertOfficerInScope: async () => undefined },
  "@/features/labels/service.server": { getResolvedLabels: async () => DL },
  "@/features/schemes/scheme-planning.server": { runningSchemes: async () => [] },
  "@/features/planning/monthly.server": { getMonthly: async () => ({ monthlyMode: "PACK_SIZE", months: [], dealers: [] }) },
  "@/features/planning/monthly-plan.server": { resolveAddableSeasonalPlanId: async () => null },
  "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => 0, latestCnRequestStatusByDealer: async () => new Map() },
  "@/lib/recovery-config": { getAutoTasksEnabled: async () => false, getCalendarEnabled: async () => true, getAppointmentPartyPlanningEnabled: async () => false },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map(), resolveDealerDisplayNames: async () => new Map(), decorateDealerNames: async (r: unknown[]) => r, dealerDisplayName: (n: string) => n },
  "./auto-task-materialization.server": { materializeDueDailyWorkTasks: async () => ({}), materializeDueDailyWorkTasksInTransaction: async () => ({}), autoTasksApplyToRole: () => true },
};
const svc = testLoader(mocks)<typeof import("./service.server")>("src/features/daily-work/service.server.ts");
const so1 = { userId: "so1", username: "so1", role: Role.SALES_OFFICER, groupId: "g1" } as AuthContext;
const so2 = { userId: "so2", username: "so2", role: Role.SALES_OFFICER, groupId: "g1" } as AuthContext;
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const eq = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const stmts = (fromIndex: number) => queries.slice(fromIndex);
// Prisma occasionally probes an idle pooled connection with bare SELECT 1 before BEGIN.
// That engine health check bypasses the simulated application round trip; don't count it as save SQL.
const txCount = (q: string[]) => q.filter((s) => s !== "BEGIN" && s !== "COMMIT" && s !== "ROLLBACK" && s !== "SELECT 1").length;

async function main() {
  const rows = (n: number, type: string, offset = 0) => Array.from({ length: n }, (_, i) => ({ dealerId: `d${i + offset}`, todaysPlan: 100 + i, entryType: "REGULAR", followUpType: type }));
  const clearTriggers = async () => { await base.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_sync ON "DailyWorkEntry"`); await base.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_audit ON "AuditLog"`); };
  async function seed(n: number) {
    await clearTriggers();
    await base.$executeRawUnsafe(`TRUNCATE "CalendarEntry","DailyTaskOutcome","DailyWorkEntry","DailyWorkDay","LateReportRequest","DailyReportPolicy","TaskRescheduleEvent","DealerAssignment","Dealer","AuditLog","User","UserGroup" CASCADE`);
    await base.userGroup.create({ data: { id: "g1", name: "MP" } });
    for (const id of ["so1", "so2"]) await base.user.create({ data: { id, name: id.toUpperCase(), username: id, passwordHash: "x", role: Role.SALES_OFFICER, groupId: "g1" } });
    await base.dealer.createMany({ data: Array.from({ length: n + 4 }, (_, i) => ({ id: `d${i}`, name: `Dealer ${String(i).padStart(3, "0")}` })) });
    await base.dealerAssignment.createMany({ data: Array.from({ length: n + 4 }, (_, i) => ({ dealerId: `d${i}`, officerId: "so1", effectiveFrom: new Date("2024-01-01") })) });
  }
  const sales = (r: unknown[], c: AuthContext = so1) => svc.saveDailyWork(c, { section: "SALES", workDate: BASE_DAY, rows: r });
  const recovery = (r: unknown[], c: AuthContext = so1) => svc.saveDailyWork(c, { section: "RECOVERY", workDate: BASE_DAY, rows: r });
  const rel = (r: unknown[], c: AuthContext = so1) => svc.saveRelationshipVisits(c, { workDate: BASE_DAY, rows: r });
  const summary = async () => svc.getDailySummary(so1, BASE_DAY, undefined, "PLAN");
  const table = async () => (await summary()).visitRows.map((v) => [v.dealerId, v.sources.join("+")]);
  const stateOf = async () => JSON.stringify({
    entries: await base.dailyWorkEntry.findMany({ orderBy: [{ section: "asc" }, { rowKey: "asc" }], select: { section: true, rowKey: true, todaysPlan: true, followUpType: true, purpose: true, dealerVisits: true, newPartyVisits: true, noPlanSections: true, status: true } }),
    audits: await base.auditLog.count(),
  });
  const touched = async () => JSON.stringify((await base.dailyWorkEntry.findMany({ orderBy: { id: "asc" }, select: { id: true, updatedAt: true } })).map((e) => [e.id, e.updatedAt.getTime()]));
  const profile = async (fn: () => Promise<unknown>, latency = 100) => { const mark = queries.length; rtt = latency; const t0 = Date.now(); await fn(); const ms = Date.now() - t0; rtt = 0; return { statements: txCount(stmts(mark)), ms }; };
  const limits = svc.DAILY_WORK_SAVE_TRANSACTION;

  /* ---- statement count: constant in the number of rows (it used to grow by one statement per row and exceed 5 s) ---- */
  // Measured BEFORE this change on the same data at 100 ms/statement: Sales save 17 statements for 3 rows, 26 for 12, and a transaction timeout (P2028) for 40.
  const measured: Record<number, { statements: number; ms: number }[]> = {};
  for (const n of [3, 12, 40]) {
    await seed(n);
    const first = await profile(() => sales(rows(n, "VISIT")));
    const again = await profile(() => sales(rows(n, "VISIT")));
    const amount = await profile(() => sales(rows(n, "VISIT").map((r, i) => (i === 0 ? { ...r, todaysPlan: 999 } : r))));
    const recov = await profile(() => recovery(rows(n, "VISIT")));
    const relation = await profile(() => rel([{ dealerId: `d${n}`, purpose: "Review" }]));
    const np = await profile(() => svc.saveDailySummary(so1, { workDate: BASE_DAY, focus: "VISITS", newPartyVisits: 2 }));
    measured[n] = [first, again, amount, recov, relation, np];
    console.log(`${String(n).padStart(2)} rows @100 ms/statement: first Sales save ${first.statements} stmts ${first.ms} ms | unchanged re-save ${again.statements} / ${again.ms} ms | amount edit ${amount.statements} / ${amount.ms} ms | Recovery (same dealers) ${recov.statements} / ${recov.ms} ms | Relationship ${relation.statements} / ${relation.ms} ms | New Party ${np.statements} / ${np.ms} ms`);
  }
  for (let k = 0; k < 6; k++) eq([measured[3]![k]!.statements, measured[12]![k]!.statements], [measured[40]![k]!.statements, measured[40]![k]!.statements], `save #${k}: 3 and 12 rows need exactly as many round trips as 40`);
  assert.ok(measured[40]!.every((m) => m.statements <= 12 && m.ms < 2_000), "every routine save is at most 12 statements (< 2 s at 100 ms/statement)");

  /* ---- unchanged saves write nothing; an amount edit does not touch Dealer Visits ---- */
  await seed(12);
  await sales(rows(12, "VISIT"));
  const before = await touched();
  await sales(rows(12, "VISIT"));
  assert.equal(await touched(), before, "re-saving identical rows rewrites no row (no updatedAt change, SUMMARY included)");
  const sumQuery = () => base.dailyWorkEntry.findFirst({ where: { section: "SUMMARY" }, select: { id: true, updatedAt: true, dealerVisits: true } });
  const sumBefore = JSON.stringify(await sumQuery());
  await sales(rows(12, "VISIT").map((r, i) => (i === 3 ? { ...r, todaysPlan: 555 } : r)));
  eq(JSON.stringify(await sumQuery()), sumBefore, "an amount edit does not touch the Dealer Visits summary");
  eq(Number((await base.dailyWorkEntry.findFirstOrThrow({ where: { rowKey: "d3", section: "SALES" } })).todaysPlan), 555, "…but the amount is saved");
  eq(await base.auditLog.count({ where: { entity: "dailyWork", entityId: { startsWith: "SALES:" } } }), 3, "every save still writes its audit record");

  // Repeated New Party Visits / Others saves still audit, but need not rewrite the same SUMMARY values.
  await svc.saveDailySummary(so1, { workDate: BASE_DAY, focus: "VISITS", newPartyVisits: 4 });
  const visitsUnchanged = await touched();
  const auditBefore = await base.auditLog.count();
  await svc.saveDailySummary(so1, { workDate: BASE_DAY, focus: "VISITS", newPartyVisits: 4 });
  assert.equal(await touched(), visitsUnchanged, "unchanged New Party Visits does not rewrite SUMMARY or dealer rows");
  assert.equal(await base.auditLog.count(), auditBefore + 1, "the repeated save still records its audit atomically");
  await svc.saveDailySummary(so1, { workDate: BASE_DAY, focus: "OTHERS", others: "Keep the same note" });
  const noteUnchanged = await touched();
  await svc.saveDailySummary(so1, { workDate: BASE_DAY, focus: "OTHERS", others: "Keep the same note" });
  assert.equal(await touched(), noteUnchanged, "unchanged Others note does not rewrite SUMMARY");
  await svc.saveDailySummary(so1, { workDate: BASE_DAY, focus: "BOTH", newPartyVisits: 5, others: "Updated note" });
  eq([(await summary()).newPartyVisits, (await summary()).others, (await summary()).dealerVisits], [5, "Updated note", 12], "genuine combined edits save without changing the derived visit count");

  /* ---- consistency of the optimized writes ---- */
  await seed(12);
  await sales(rows(4, "VISIT")); await recovery(rows(4, "VISIT", 2));
  eq(await table(), [["d0", "SALES"], ["d1", "SALES"], ["d2", "SALES+RECOVERY"], ["d3", "SALES+RECOVERY"], ["d4", "RECOVERY"], ["d5", "RECOVERY"]], "the same dealer in both sections is one row with both sources");
  eq((await summary()).dealerVisits, 6, "unique dealers counted once");
  await sales(rows(4, "VISIT").map((r, i) => (i === 2 ? { ...r, followUpType: "TELEPHONIC" } : r)));
  eq(await table(), [["d0", "SALES"], ["d1", "SALES"], ["d2", "RECOVERY"], ["d3", "SALES+RECOVERY"], ["d4", "RECOVERY"], ["d5", "RECOVERY"]], "Visit → Telephonic removes only the Sales link; Recovery survives");
  await sales([]); await recovery([]);
  eq([await table(), (await summary()).dealerVisits, (await summary()).visitsEntered], [[], 0, false], "removing every source returns Visits to 'not entered'");
  await svc.setDailyNoPlan(so1, { workDate: BASE_DAY, section: "VISITS", noPlan: true });
  await sales(rows(1, "VISIT"));
  eq([(await summary()).dealerVisits, (await svc.getDailyStatus(so1, BASE_DAY)).sections.find((x) => x.section === "VISITS")!.status !== "NO_PLAN"], [1, true], "a linked Visit clears a stale Visits No Plan, in the same save");
  await sales([]);
  // Relationship purposes survive Sales / Recovery changes and unrelated saves; New Party Visits is untouched by them.
  await rel([{ dealerId: "d7", purpose: "Quarterly review" }]);
  await svc.saveDailySummary(so1, { workDate: BASE_DAY, focus: "VISITS", newPartyVisits: 4 });
  await sales(rows(2, "VISIT", 7));
  await sales(rows(1, "TELEPHONIC", 7));
  eq(await table(), [["d7", "RELATIONSHIP"]], "the Relationship component and its purpose stay when the Sales source goes away");
  eq([(await base.dailyWorkEntry.findFirstOrThrow({ where: { section: "RELATIONSHIP" } })).purpose, (await summary()).newPartyVisits], ["Quarterly review", 4], "purpose and New Party Visits unchanged");
  await rel([{ dealerId: "d7", purpose: "Quarterly review" }]);
  eq(await base.dailyWorkEntry.count({ where: { section: "RELATIONSHIP" } }), 1, "a repeated Relationship save never duplicates");
  assert.notEqual(await code(rel([{ dealerId: "d9", purpose: "   " }])), 0, "a blank purpose is still refused");
  assert.equal(await code(sales([{ dealerId: "d9", todaysPlan: 1, entryType: "REGULAR" }])), 422, "a NEW entry without a Follow-up Type is still refused");
  assert.equal(await code(sales([{ dealerId: "o-unknown", todaysPlan: 1, entryType: "REGULAR", followUpType: "VISIT" }])), 403, "a dealer outside the officer's scope is still refused");
  assert.equal(await code(sales(rows(1, "VISIT"), so2)), 403, "another officer cannot save for these dealers");

  /* ---- multiple batches and protected submitted records ---- */
  await seed(12);
  await sales(rows(3, "VISIT", 0).map((r) => ({ ...r, todaysPlan: 100 })));
  for (const section of ["RECOVERY", "APPOINTMENT", "OTHERS"]) await svc.setDailyNoPlan(so1, { workDate: BASE_DAY, section, noPlan: true });
  await svc.submitDailyWorkDay(so1, { workDate: BASE_DAY });
  const submittedQuery = () => base.dailyWorkEntry.findMany({ where: { status: "PLAN_SUBMITTED" }, orderBy: { id: "asc" }, select: { id: true, dealerVisits: true, followUpType: true, todaysPlan: true, updatedAt: true } });
  const submittedBefore = JSON.stringify(await submittedQuery());
  await recovery(rows(2, "VISIT", 1)); // d1 and d2 were planned in the first batch: not counted again
  await recovery(rows(4, "VISIT", 1)); // d3 and d4 are new for the day
  eq([(await summary()).dealerVisits, (await summary()).visitRows.map((v) => [v.dealerId, v.alreadyPlanned])], [2, [["d1", true], ["d2", true], ["d3", false], ["d4", false]]], "a dealer is not counted twice across batches");
  eq(JSON.stringify(await submittedQuery()), submittedBefore, "submitted rows are never rewritten by later saves");

  /* ---- rapid repeated saves and concurrent saves for the same day (a wider pool so they really overlap) ---- */
  const wide = new PrismaClient({ datasources: { db: { url: raw } } });
  const wideSvc = testLoader({ ...mocks, "@/lib/prisma": { prisma: wide } })<typeof import("./service.server")>("src/features/daily-work/service.server.ts");
  await seed(12);
  await sales(rows(2, "TELEPHONIC"));
  const wideSales = (r: unknown[]) => wideSvc.saveDailyWork(so1, { section: "SALES", workDate: BASE_DAY, rows: r });
  const wideRecovery = (r: unknown[]) => wideSvc.saveDailyWork(so1, { section: "RECOVERY", workDate: BASE_DAY, rows: r });
  const settled = await Promise.all([
    wideSales(rows(5, "VISIT")), wideSales(rows(5, "VISIT")), wideRecovery(rows(5, "VISIT", 3)), wideRecovery(rows(5, "VISIT", 3)),
    wideSvc.saveRelationshipVisits(so1, { workDate: BASE_DAY, rows: [{ dealerId: "d10", purpose: "Courtesy" }] }),
    wideSvc.saveDailySummary(so1, { workDate: BASE_DAY, focus: "VISITS", newPartyVisits: 3 }),
  ].map((p) => p.then(() => "ok", (e: { status?: number }) => `err${e.status}`)));
  eq(settled, ["ok", "ok", "ok", "ok", "ok", "ok"], "overlapping saves for one day are serialized by the day lock and all succeed");
  eq(await table(), [["d0", "SALES"], ["d1", "SALES"], ["d2", "SALES"], ["d3", "SALES+RECOVERY"], ["d4", "SALES+RECOVERY"], ["d5", "RECOVERY"], ["d6", "RECOVERY"], ["d7", "RECOVERY"], ["d10", "RELATIONSHIP"]], "the result is exactly the union of the requests");
  const sum = await base.dailyWorkEntry.findFirstOrThrow({ where: { section: "SUMMARY" } });
  eq([sum.dealerVisits, sum.newPartyVisits, await base.dailyWorkEntry.count({ where: { section: "SUMMARY" } })], [9, 3, 1], "one SUMMARY row, the unique dealer count, New Party Visits unchanged");
  for (let k = 0; k < 6; k++) await sales(rows(5, "VISIT")); // rapid repeats
  eq([await base.dailyWorkEntry.count({ where: { section: "SALES" } }), (await summary()).dealerVisits], [5, 9], "repeated saves create no duplicates and keep the count");
  await wide.$disconnect();

  /* ---- a forced failure during synchronization / audit: the whole save rolls back ---- */
  await seed(12);
  await sales(rows(2, "VISIT")); // d0, d1
  const clean = await stateOf();
  await base.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
  await base.$executeRawUnsafe(`CREATE TRIGGER fail_sync BEFORE INSERT OR UPDATE ON "DailyWorkEntry" FOR EACH ROW WHEN (NEW."section" = 'SUMMARY' AND NEW."followUpType" = 'DERIVED') EXECUTE FUNCTION test_fail()`);
  assert.notEqual(await code(sales(rows(4, "VISIT"))), 0, "the save fails when the Dealer Visits synchronization fails");
  assert.equal(await stateOf(), clean, "…and the Sales rows, their Follow-up Types, the summary and the audit are exactly as before (complete rollback)");
  assert.notEqual(await code(rel([{ dealerId: "d6", purpose: "x" }])), 0);
  assert.equal(await stateOf(), clean, "a failed Relationship save leaves nothing behind either");
  await clearTriggers();
  await base.$executeRawUnsafe(`CREATE TRIGGER fail_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION test_fail()`);
  assert.notEqual(await code(sales(rows(4, "VISIT"))), 0, "an audit failure fails the save");
  await clearTriggers();
  assert.equal(await stateOf(), clean, "…and rolls the origin entries and the summary back with it");
  await sales(rows(4, "VISIT"));
  eq((await summary()).dealerVisits, 4, "after the failures the same save succeeds normally");

  /* ---- limits: a save slower than the former 5 s completes inside the bounded limit; beyond it, a clear retryable failure with complete rollback ---- */
  await seed(40);
  const slow = await profile(() => sales(rows(40, "VISIT")), 450);
  console.log(`40 rows at 450 ms/statement: ${slow.statements} statements, ${slow.ms} ms`);
  const clean2 = await stateOf();
  limits.timeout = 400; rtt = 100;
  let failure: { status?: number; message?: string } = {};
  await sales(rows(40, "VISIT").map((r) => ({ ...r, todaysPlan: 7 }))).catch((e) => { failure = e; });
  limits.timeout = 15_000; rtt = 0;
  eq([failure.status, failure.message], [503, DL["daily_work.validation.save_timeout"]], "an expired draft save is a clear, retryable 503");
  assert.equal(await stateOf(), clean2, "…with nothing partially saved");
  console.log("save-draft.integration.ts — all scenarios passed");
}
main().then(async () => { await base.$disconnect(); }, async (e) => { console.error(e); await base.$disconnect(); process.exit(1); });
