/**
 * Daily Report saves and final submission against a REAL, disposable PostgreSQL database with SIMULATED NETWORK LATENCY (every statement waits a fixed round trip first). The
 * database itself needs milliseconds; what exhausted Prisma's 5 s interactive-transaction budget is the number of sequential round trips, so this suite counts them and proves the
 * bounded limits, the all-or-nothing rollback and the idempotency of the final submission.
 *
 *   createdb report_tx_test && DATABASE_URL=postgresql://localhost:5432/report_tx_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   REPORT_TX_TEST_URL=postgresql://localhost:5432/report_tx_test npm run test:report-finalize:db
 *
 * Only a LOCAL database named `report_tx_test` is permitted — the script TRUNCATEs the tables it uses. The client has ONE pooled connection: any statement issued on the global client
 * while a transaction is open (a stale / wrong client) would wait for that connection and fail, so passing proves every helper uses the active transaction client.
 */
import assert from "node:assert/strict";
import { Prisma, PrismaClient, Role } from "@prisma/client";
import * as realDailyWork from "@/lib/daily-work";
import * as realLabels from "@/features/labels/labels";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

const raw = process.env.REPORT_TX_TEST_URL;
if (!raw || !["localhost", "127.0.0.1"].includes(new URL(raw).hostname) || new URL(raw).pathname !== "/report_tx_test")
  throw new Error("Only a local database named report_tx_test is permitted (set REPORT_TX_TEST_URL).");
const withPool = (u: string) => { const x = new URL(u); x.searchParams.set("connection_limit", "1"); x.searchParams.set("pool_timeout", "3"); return x.toString(); };
let rtt = 0;
const base = new PrismaClient({ datasources: { db: { url: withPool(raw) } }, log: [{ emit: "event", level: "query" }] });
const queries: string[] = [];
base.$on("query", (e: { query: string }) => { queries.push(e.query.replace(/\s+/g, " ").trim()); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prisma = base.$extends({ query: { async $allOperations({ args, query }) { if (rtt) await sleep(rtt); return query(args); } } }) as unknown as PrismaClient;
const BASE_DAY = "2026-10-14";
let clock = BASE_DAY;
let now = new Date(`${BASE_DAY}T06:00:00Z`);
realDailyWork.dailyWorkClock.now = () => now;
const setDay = (n: number) => { clock = day(n); now = new Date(`${clock}T06:00:00Z`); }; // 11:30 IST of that business day
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
const day = (n: number) => new Date(Date.parse(`${BASE_DAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const stmts = (fromIndex: number) => queries.slice(fromIndex);
const txCount = (q: string[]) => q.filter((s) => s !== "BEGIN" && s !== "COMMIT" && s !== "ROLLBACK").length;

async function main() {
  const clearTriggers = async () => { for (const [trigger, table] of [["fail_late", "LateReportRequest"], ["fail_audit", "AuditLog"], ["fail_day", "DailyWorkDay"], ["fail_event", "TaskRescheduleEvent"]]) await base.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON "${table}"`); };
  const seq = { n: 0 };
  /** Fresh database state: one Sales Officer with `n` manual Sales tasks + 4 Calendar tasks, submitted as one plan; returns the units a report can give outcomes to. */
  async function seed(n: number) {
    await clearTriggers();
    await base.$executeRawUnsafe(`TRUNCATE "CalendarEntry","DailyTaskOutcome","DailyWorkEntry","DailyWorkDay","LateReportRequest","DailyReportPolicy","TaskRescheduleEvent","DealerAssignment","Dealer","AuditLog","User","UserGroup" CASCADE`);
    setDay(0); seq.n++;
    await base.userGroup.create({ data: { id: "g1", name: "MP" } });
    for (const id of ["so1", "so2"]) await base.user.create({ data: { id, name: id.toUpperCase(), username: id, passwordHash: "x", role: Role.SALES_OFFICER, groupId: "g1" } });
    await base.dealer.createMany({ data: Array.from({ length: n + 4 }, (_, i) => ({ id: `d${i}`, name: `Dealer ${i}` })).concat([{ id: "o1", name: "Other" }]) });
    await base.dealerAssignment.createMany({ data: Array.from({ length: n + 4 }, (_, i) => ({ dealerId: `d${i}`, officerId: "so1", effectiveFrom: new Date("2024-01-01") })).concat([{ dealerId: "o1", officerId: "so2", effectiveFrom: new Date("2024-01-01") }]) });
    for (let i = 0; i < 4; i++) await base.calendarEntry.create({ data: { ownerId: "so1", kind: "TASK", date: new Date(`${BASE_DAY}T00:00:00Z`), taskSection: "SALES", dealerId: `d${i}`, amount: 200, entryType: "REGULAR" } as never });
    await svc.getDailyWork(so1, "SALES", BASE_DAY, undefined, "PLAN");
    await svc.saveDailyWork(so1, { section: "SALES", workDate: BASE_DAY, rows: Array.from({ length: n }, (_, i) => ({ dealerId: `d${i + 4}`, todaysPlan: 100, entryType: "REGULAR", followUpType: "TELEPHONIC" })) });
    for (const section of ["RECOVERY", "APPOINTMENT", "VISITS", "OTHERS"]) await svc.setDailyNoPlan(so1, { workDate: BASE_DAY, section, noPlan: true });
    await svc.submitDailyWorkDay(so1, { workDate: BASE_DAY });
    const rep = await svc.getDailyWork(so1, "SALES", BASE_DAY, undefined, "REPORT");
    const entries = rep.dealers.map((d) => ({ entryId: d.entryId, tasks: d.tasks ?? [] }));
    const units = entries.flatMap((e) => e.tasks.map((t) => ({ entryId: e.entryId, unitType: t.unitType, unitId: t.unitId })));
    eq(units.length, n + 4, "every row carries its task");
    return { entries, units };
  }
  let nextDate = day(1);
  const choose = (i: number): Record<string, unknown> => i % 3 === 0 ? { outcome: "COMPLETED", actualAmount: 100 } : i % 3 === 1 ? { outcome: "RESCHEDULED", nextDate } : { outcome: "ABANDONED", reasonCode: "OTHER", reason: "Dealer closed the account and moved to another distributor" };
  type Seeded = Awaited<ReturnType<typeof seed>>;
  const draft = (w: Seeded, c: AuthContext = so1, workDate = BASE_DAY) => svc.enterTaskOutcomes(c, { section: "SALES", workDate, entries: w.entries.map((e) => ({ entryId: e.entryId, units: w.units.filter((u) => u.entryId === e.entryId).map((u) => ({ unitType: u.unitType, unitId: u.unitId, ...choose(w.units.indexOf(u)) })) })) });
  const submit = (c: AuthContext = so1, workDate = BASE_DAY) => svc.submitDailyReport(c, { workDate, selfRating: 7 });
  const snap = async () => JSON.stringify({
    day: await base.dailyWorkDay.findMany({ orderBy: { id: "asc" }, select: { officerId: true, status: true, selfRating: true, finalizedAt: true } }),
    entries: await base.dailyWorkEntry.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, todaysActual: true } }),
    outcomes: await base.dailyTaskOutcome.findMany({ orderBy: { id: "asc" }, select: { id: true, state: true, outcome: true, actualAmount: true, nextDate: true, committedAt: true, continuedAsId: true } }),
    calendar: await base.calendarEntry.findMany({ orderBy: { id: "asc" }, select: { id: true, date: true, dailyWorkEntryId: true, abandonedAt: true } }),
    events: await base.taskRescheduleEvent.count(), audits: await base.auditLog.count(),
    late: await base.lateReportRequest.findMany({ select: { status: true, completedAt: true } }),
  });
  const failOn = async (table: string, trigger: string, when: string, event = "UPDATE") => {
    await base.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
    await base.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE ${event} ON "${table}" FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION test_fail()`);
  };
  const statementsOf = async (fn: () => Promise<unknown>) => { const mark = queries.length; await fn(); return txCount(stmts(mark)); };
  const finalLimit = svc.DAILY_WORK_FINAL_TRANSACTION, saveLimit = svc.DAILY_WORK_SAVE_TRANSACTION;

  /* ---- limits: explicit, bounded, execution timeout apart from connection wait ---- */
  eq([Object.keys(finalLimit).join(), Object.keys(saveLimit).join()], ["timeout,maxWait", "timeout,maxWait"]);
  assert.ok(saveLimit.timeout > 5_000 && saveLimit.timeout <= finalLimit.timeout && finalLimit.timeout <= 60_000 && saveLimit.maxWait <= 10_000 && finalLimit.maxWait <= 10_000, "bounded limits, above the former 5 s, within the 60 s route allowance");

  /* ---- round trips: constant in the number of tasks (this is what exhausted the former 5 s budget) ---- */
  let w = await seed(12);
  const draftStatements12 = await statementsOf(() => draft(w));
  const finalStatements12 = await statementsOf(() => submit());
  console.log(`measured: draft save ${draftStatements12} statements, final submission ${finalStatements12} statements for 16 tasks (the previous implementation used 48 for 16 tasks)`);
  w = await seed(40);
  const draftStatements40 = await statementsOf(() => draft(w));
  const finalStatements40 = await statementsOf(() => submit());
  eq([draftStatements40, finalStatements40], [draftStatements12, finalStatements12], "44 tasks need exactly as many round trips as 16: the statement count no longer grows with the number of tasks");
  assert.ok(finalStatements12 <= 20, "a final submission is a bounded number of statements");

  /* ---- successful save + final submission: effects, history and audit all committed together ---- */
  w = await seed(12);
  rtt = 50;
  await draft(w);
  eq(await base.dailyTaskOutcome.count({ where: { state: "DRAFT" } }), 16, "outcome drafts saved");
  eq(await base.auditLog.count({ where: { entity: "dailyWork", entityId: { startsWith: "SALES:" }, summary: { startsWith: "Saved task outcomes" } } }), 1, "the draft save's audit row committed with it");
  const beforeFinal = await base.dailyWorkEntry.findMany({ orderBy: { id: "asc" }, select: { id: true, todaysActual: true } });
  await submit();
  rtt = 0;
  const done = await base.dailyWorkDay.findFirstOrThrow({ where: { officerId: "so1" } });
  eq([done.status, done.selfRating], ["FINALIZED", 7], "report finalized with the self-rating");
  eq(await base.dailyWorkEntry.count({ where: { status: "FINALIZED" } }), await base.dailyWorkEntry.count({ where: { status: { not: "DRAFT" } } }), "every submitted entry is finalized");
  eq(await base.dailyTaskOutcome.count({ where: { state: "COMMITTED" } }), 16, "all outcomes committed");
  const resched = w.units.filter((_, i) => i % 3 === 1), manualResched = resched.filter((u) => u.unitType === "MANUAL_ROW").length;
  eq([resched.length, await base.taskRescheduleEvent.count()], [5, 5], "one history event per rescheduled task");
  eq(await base.calendarEntry.count({ where: { createdById: "so1" } }), manualResched, "each rescheduled manual task continued as ONE Calendar task");
  eq(await base.calendarEntry.count({ where: { abandonedAt: { not: null } } }), w.units.filter((u, i) => i % 3 === 2 && u.unitType === "CALENDAR_ENTRY").length, "abandoned Calendar tasks ended");
  eq(await base.auditLog.count({ where: { entity: "dailyTaskOutcome" } }), 16, "one audit row per committed outcome");
  eq(await base.auditLog.count({ where: { entity: "dailyWork", entityId: `REPORT:${BASE_DAY}` } }), 1, "one report audit row");
  eq((await base.dailyWorkEntry.findMany({ orderBy: { id: "asc" }, select: { id: true, todaysActual: true } })).length, beforeFinal.length, "no entry was added or lost");
  // the rescheduled manual tasks continued as Calendar tasks; the rescheduled Calendar tasks moved themselves (unlinked, same id)
  eq((await base.dailyTaskOutcome.count({ where: { continuedAsType: "CALENDAR_ENTRY" } })) > 0, true);
  eq(await code(submit()), 409, "a repeated submission keeps the existing already-finalized answer");
  eq([await base.taskRescheduleEvent.count(), await base.auditLog.count({ where: { entity: "dailyWork", entityId: `REPORT:${BASE_DAY}` } })], [5, 1], "…and adds no second event or audit row");

  /* ---- slower than the former 5 s limit, inside the new bounded limit ---- */
  w = await seed(12);
  await draft(w);
  rtt = 400; const t0 = Date.now();
  await submit();
  const took = Date.now() - t0; rtt = 0;
  assert.ok(took > 5_000 && took < finalLimit.timeout, `a submission of ${took} ms (more than the old 5000 ms) now completes`);
  eq((await base.dailyWorkDay.findFirstOrThrow()).status, "FINALIZED");
  w = await seed(12);
  const saveStart = Date.now(); rtt = 800; await draft(w); const saveTook = Date.now() - saveStart; rtt = 0;
  assert.ok(saveTook > 5_000 && saveTook < saveLimit.timeout, `a draft save of ${saveTook} ms (more than the old 5000 ms) now completes`);

  /* ---- beyond the new limit: a clear retryable failure and a COMPLETE rollback ---- */
  w = await seed(12);
  await draft(w);
  let before = await snap();
  finalLimit.timeout = 500; rtt = 100;
  let failure: { status?: number; message?: string } = {};
  await submit().catch((e) => { failure = e; });
  finalLimit.timeout = 30_000; rtt = 0;
  eq([failure.status, failure.message], [503, DL["daily_work.validation.report_submit_timeout"]], "an expired final submission is a retryable 503 with the label wording");
  assert.equal(await snap(), before, "nothing committed: no outcome committed, no task moved, no history, no audit, report still open");
  saveLimit.timeout = 300; rtt = 100;
  failure = {};
  await draft(w).catch((e) => { failure = e; });
  saveLimit.timeout = 15_000; rtt = 0;
  eq([failure.status, failure.message], [503, DL["daily_work.validation.save_timeout"]], "an expired draft save is a retryable 503 with the label wording");
  assert.equal(await snap(), before, "…and left the earlier drafts and the audit trail untouched");

  /* ---- failures injected AFTER the task changes and at the end: the whole finalization rolls back ---- */
  const cases: [string, () => Promise<void>][] = [
    ["a failure while recording the reschedule history (after the tasks were updated)", () => failOn("TaskRescheduleEvent", "fail_event", "TRUE", "INSERT")],
    ["a failure while finalizing the day", () => failOn("DailyWorkDay", "fail_day", `NEW."status" = 'FINALIZED'`)],
    ["a failure while completing the late-report request", () => failOn("LateReportRequest", "fail_late", `NEW."status" = 'COMPLETED'`)],
    ["a failure while writing the final audit record", () => failOn("AuditLog", "fail_audit", `NEW."entityId" LIKE 'REPORT:%'`, "INSERT")],
  ];
  for (const [name, inject] of cases) {
    w = await seed(12);
    setDay(2); nextDate = day(5); // past the 12:00 deadline of day 0: only an approved late request keeps the report open
    await base.lateReportRequest.create({ data: { officerId: "so1", workDate: new Date(`${BASE_DAY}T00:00:00Z`), reason: "network down", status: "APPROVED", decidedAt: new Date(), decidedById: "so2", decidedByName: "Reviewer", decidedByRole: "SALES_OFFICER", deadline: new Date(`${day(1)}T06:30:00Z`) } });
    await draft(w);
    before = await snap();
    await inject();
    assert.notEqual(await code(submit()), 0, `${name}: the submission fails`);
    await clearTriggers();
    assert.equal(await snap(), before, `${name}: complete rollback — drafts, tasks, history, audit and the approved late request are all unchanged`);
    eq((await base.lateReportRequest.findFirstOrThrow()).status, "APPROVED", `${name}: the approval was not consumed`);
    await submit(); // the same drafts submit cleanly afterwards
    eq([(await base.dailyWorkDay.findFirstOrThrow()).status, (await base.lateReportRequest.findFirstOrThrow()).status], ["FINALIZED", "COMPLETED"], `${name}: a retry then succeeds and consumes the approval exactly once`);
    nextDate = day(1);
  }

  /* ---- validation, ownership, deadline, finalized ---- */
  w = await seed(12);
  assert.equal(await code(submit()), 422, "outcomes not entered yet: the report is incomplete (validation, not a database error)");
  eq(await code(draft(w, so2)), 409, "another officer's entries are refused (ownership)");
  eq(await code(svc.submitDailyReport(so1, { workDate: BASE_DAY, selfRating: 0 })), 422, "the self-rating is still required");
  await draft(w);
  setDay(2); nextDate = day(5);
  eq(await code(submit()), 422, "after the deadline without an approval the submission is refused (deadline, not a database error)");
  eq(await code(draft(w)), 422, "…and so are further draft saves");
  setDay(0); nextDate = day(1);
  await submit();
  eq(await code(draft(w)), 409, "a finalized report accepts no further outcome saves");
  eq(await code(submit()), 409, "…nor a second submission");

  /* ---- a report save returns the completion the status read computes (the client writes it into the cached status instead of re-reading it) ---- */
  {
    w = await seed(4);
    const partial = { ...w, entries: w.entries.slice(0, 1), units: w.units.filter((u) => u.entryId === w.entries[0]!.entryId) };
    for (const [label, save] of [["a partial report", () => draft(partial)], ["the complete report", () => draft(w)]] as const) {
      const res = await save();
      const status = await svc.getDailyStatus(so1, BASE_DAY);
      assert.ok(res.report, `${label}: the save returns the report completion`);
      eq(res.report!.sections, status.reportSections, `${label}: section ticks (planStatus / reported / complete) equal the authoritative status read`);
      eq(res.report!.hasBatches, status.hasSubmittedWork, `${label}: submitted-work flag equals the status read`);
      eq(!status.isFinalized && res.report!.complete && !status.reportDeadlinePassed, status.canSubmitReport, `${label}: Submit Report follows the same rule as the status read`);
    }
    const saveStatements = await statementsOf(() => draft(w));
    const statusStatements = await statementsOf(() => svc.getDailyStatus(so1, BASE_DAY));
    const loadStatements = await statementsOf(() => svc.getDailyWork(so1, "SALES", BASE_DAY, undefined, "REPORT"));
    console.log(`measured: report save incl. completion ${saveStatements} statements; the status re-read it replaces ${statusStatements} statements; Daily Report load (Sales, 8 tasks) ${loadStatements} statements`);
  }

  /* ---- concurrent / repeated submissions (a wider pool so the two really overlap) ---- */
  const wide = new PrismaClient({ datasources: { db: { url: raw } } });
  const wideSvc = testLoader({ ...mocks, "@/lib/prisma": { prisma: wide } })<typeof import("./service.server")>("src/features/daily-work/service.server.ts");
  w = await seed(12);
  await draft(w);
  const results = await Promise.all([1, 2, 3].map(() => wideSvc.submitDailyReport(so1, { workDate: BASE_DAY, selfRating: 7 }).then(() => "ok", (e: { status?: number }) => `err${e.status}`)));
  eq(results.filter((r) => r === "ok").length, 1, "exactly one of three simultaneous submissions succeeded");
  eq(results.filter((r) => r === "err409").length, 2, "the others got the already-submitted answer");
  eq([await base.taskRescheduleEvent.count(), await base.auditLog.count({ where: { entity: "dailyWork", entityId: `REPORT:${BASE_DAY}` } }), await base.auditLog.count({ where: { entity: "dailyTaskOutcome" } }), await base.calendarEntry.count({ where: { createdById: "so1" } })], [5, 1, 16, w.units.filter((u, i) => i % 3 === 1 && u.unitType === "MANUAL_ROW").length], "no duplicate history, audit rows or Calendar tasks");
  await wide.$disconnect();
  console.log("report-finalize.integration.ts — all scenarios passed");
}
main().then(async () => { await base.$disconnect(); }, async (e) => { console.error(e); await base.$disconnect(); process.exit(1); });
