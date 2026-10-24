/**
 * Daily Report task outcomes (Completed / Not Completed — Reschedule / Abandon) against a REAL, disposable PostgreSQL database.
 *
 *   createdb billing_task_test && DATABASE_URL=postgresql://localhost:5432/billing_task_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   BILLING_TASK_TEST_URL=postgresql://localhost:5432/billing_task_test npm run test:task-outcomes:db
 *
 * Only a LOCAL database named `billing_task_test` is permitted — the script TRUNCATEs the tables it uses.
 */
import assert from "node:assert/strict";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import * as realDailyWork from "@/lib/daily-work";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";
import { acceptReceipts } from "@/lib/dealer-last-payment";
import * as realLabels from "@/features/labels/labels";

const url = process.env.BILLING_TASK_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/billing_task_test")
  throw new Error("Only a local database named billing_task_test is permitted (set BILLING_TASK_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
const BASE = "2026-10-14"; // day(n) = BASE + n, fixed
let clock = BASE; // the Daily Work business date the services see (advanced as the scenarios move through time)
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => tx.auditLog.create({ data }) },
  "@/lib/daily-work": { ...realDailyWork, currentBusinessDate: (d?: Date) => (d ? realDailyWork.currentBusinessDate(d) : clock) },
  "@/features/cn-requests/service.server": { latestCnRequestStatusByDealer: async () => new Map() },
  "@/lib/recovery-config": { getCalendarEnabled: async () => true },
});

// The real Daily Work service on the same disposable database (everything outside this feature stubbed to its neutral value).
const DEFAULT_LABELS = realLabels.DEFAULT_LABELS as Record<string, string>;
const serviceMocks = {
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => ({}) },
  "@/lib/daily-work": { ...realDailyWork, currentBusinessDate: (d?: Date) => (d ? realDailyWork.currentBusinessDate(d) : clock) },
  "@/lib/scope": { getCurrentOwnerByDealer: async (ids: string[]) => { const rows = await prisma.dealerAssignment.findMany({ where: { dealerId: { in: ids }, effectiveTo: null }, orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }] }); return new Map(rows.map((r) => [r.dealerId, r.officerId])); }, getCurrentDealerIds: async (id: string) => (await prisma.dealerAssignment.findMany({ where: { officerId: id } })).map((a) => a.dealerId), getOfficerScope: async (c: AuthContext) => ({ all: false, ids: [c.userId] }), assertOfficerInScope: async () => undefined },
  "@/features/labels/service.server": { getResolvedLabels: async () => DEFAULT_LABELS },
  "@/features/schemes/scheme-planning.server": { runningSchemes: async () => [] },
  "@/features/planning/monthly.server": { getMonthly: async () => ({ monthlyMode: "PACK_SIZE", months: [], dealers: [] }) },
  "@/features/planning/monthly-plan.server": { resolveAddableSeasonalPlanId: async () => null },
  "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => 0, latestCnRequestStatusByDealer: async () => new Map() },
  "@/lib/recovery-config": { getAutoTasksEnabled: async () => false, getCalendarEnabled: async () => true, getAppointmentPartyPlanningEnabled: async () => false },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map(), resolveDealerDisplayNames: async () => new Map(), decorateDealerNames: async (r: unknown[]) => r, dealerDisplayName: (n: string) => n },
  "./auto-task-materialization.server": { materializeDueDailyWorkTasks: async () => ({}), materializeDueDailyWorkTasksInTransaction: async () => ({}), autoTasksApplyToRole: () => true },
};
const dw = testLoader(serviceMocks);
const svc = dw<typeof import("./service.server")>("src/features/daily-work/service.server.ts");
const lock = load<typeof import("./day-lock.server")>("src/features/daily-work/day-lock.server.ts");

const eq = (actual: unknown, expected: unknown, message?: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const ctx = (userId: string, role: Role, groupId: string | null = "g1", permissions?: Record<string, string[]>): AuthContext => ({ userId, username: userId, role, groupId, permissions }) as AuthContext;
const admin = ctx("admin", Role.SUPER_ADMIN, null), so1 = ctx("so1", Role.SALES_OFFICER), so2 = ctx("so2", Role.SALES_OFFICER), rm = ctx("rm", Role.REGIONAL_MANAGER);
const day = (n: number) => new Date(Date.parse(`${BASE}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const batch = (officer: string, date: string) => `draft:${officer}:${date}`;

const dateOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const setClock = (d: string) => { clock = d; realDailyWork.dailyWorkClock.now = () => new Date(`${d}T05:00:00Z`); }; // 10:30 IST: inside every report window
const noPlan = async (c: AuthContext, date: string, sections: string[]) => { for (const section of sections) await svc.setDailyNoPlan(c, { workDate: date, section, noPlan: true }); };
const rowOf = async (c: AuthContext, section: "SALES" | "RECOVERY", date: string, dealerId: string) => (await svc.getDailyWork(c, section, date, undefined, "REPORT")).dealers.find((d) => d.dealerId === dealerId)!;
const unitOf = (r: { tasks?: { unitType: string; unitId: string }[] }) => r.tasks![0]!;
const post = (c: AuthContext, section: "SALES" | "RECOVERY", date: string, r: { entryId: string; tasks?: { unitType: string; unitId: string }[] }, f: Record<string, unknown>) =>
  svc.enterTaskOutcomes(c, { section, workDate: date, entries: [{ entryId: r.entryId, units: [{ unitType: unitOf(r).unitType, unitId: unitOf(r).unitId, ...f }] }] });
const counts = async () => ({
  outcomes: await prisma.dailyTaskOutcome.count(), committed: await prisma.dailyTaskOutcome.count({ where: { state: "COMMITTED" } }), calendar: await prisma.calendarEntry.count(),
  events: await prisma.taskRescheduleEvent.count(), receipts: await prisma.dealerPaymentReceipt.count(), exceptions: await prisma.billingException.count(), tasks: await prisma.billingExceptionTask.count(),
});

/** Real transactions with injected network latency: row count must not multiply round trips. */
async function batchDraftRegression() {
  const date = day(20), workDate = new Date(`${date}T00:00:00Z`);
  setClock(date);
  await prisma.dailyWorkDay.create({ data: { officerId: "so1", workDate, currentBatchId: "batch-benchmark-open", status: "OPEN" } });
  const createRows = async (prefix: string, n: number) => {
    const data = Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, officerId: "so1", dealerId: "A", rowKey: `${prefix}-${i}`, workDate, batchId: "batch-benchmark-submitted", section: "RECOVERY", todaysPlan: 1000, status: "PLAN_SUBMITTED" }));
    await prisma.dailyWorkEntry.createMany({ data });
    return data.map((r) => ({ entryId: r.id, units: [{ unitType: "MANUAL_ROW", unitId: r.id, outcome: "COMPLETED", actualAmount: 800 }], paymentMode: "UPI" }));
  };
  let latencyMs = 0, failAudit = false;
  const statements: string[] = [];
  const roundTrip = async (name: string) => { statements.push(name); if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs)); };
  const measuredPrisma = new Proxy(prisma, {
    get(target, key, receiver) {
      if (key !== "$transaction") return Reflect.get(target, key, receiver);
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) => {
        assert.equal(options, undefined, "outcome autosave must retain Prisma's default 5-second timeout");
        return target.$transaction(async (tx) => fn(new Proxy(tx, {
          get(t, k, r) {
            const value = Reflect.get(t, k, r);
            if (k !== "$queryRaw" && k !== "$executeRaw") return value;
            return async (...args: unknown[]) => { await roundTrip(String(k)); return Reflect.apply(value, t, args); };
          },
        })));
      };
    },
  });
  const measured = testLoader({ ...serviceMocks, "@/lib/prisma": { prisma: measuredPrisma },
    "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient) => { await roundTrip("audit"); if (failAudit) throw new Error("test audit failure"); return tx.auditLog.create({ data }); } },
  })<typeof import("./service.server")>("src/features/daily-work/service.server.ts");
  const send = (entries: unknown[]) => measured.enterTaskOutcomes(so1, { section: "RECOVERY", workDate: date, entries });
  // Reproduce the screenshot: two automatic Billing Exception tasks for the SAME dealer.
  const autoRows = await createRows("batch-auto", 2);
  const automatic = [];
  for (const [i, row] of autoRows.entries()) {
    const exception = await prisma.billingException.create({ data: { dealerId: "A", billingDate: workDate, billNo: `benchmark-${i}`, authPerson: "Admin", createdById: "admin", requestId: `benchmark-${i}`, snapDays: 90, snapParty: "Alpha Traders", snapDealerStatus: "ACTIVE" } });
    const task = await prisma.billingExceptionTask.create({ data: { billingExceptionId: exception.id, dealerId: "A", officerId: "so1", amount: i ? 11111 : 12444, promisedDate: workDate, taskDate: workDate, dailyWorkEntryId: row.entryId, dailyWorkContribution: i ? 11111 : 12444 } });
    await prisma.dailyWorkEntry.update({ where: { id: row.entryId }, data: { todaysPlan: task.amount } });
    automatic.push({ entryId: row.entryId, units: [{ unitType: "BILLING_EXCEPTION", unitId: task.id, outcome: null }] });
  }
  latencyMs = 250; statements.length = 0;
  assert.equal((await send(automatic)).count, 2);
  assert.equal(statements.length, 8, "two unselected auto tasks are saved with bounded round trips (the deadline check adds one constant statement)");
  const autoSnapshots = await prisma.dailyTaskOutcome.findMany({ where: { entryId: { in: autoRows.map((e) => e.entryId) } }, orderBy: { plannedAmount: "asc" } });
  eq(autoSnapshots.map((o) => [o.unitType, Number(o.plannedAmount), o.outcome]), [["BILLING_EXCEPTION", 11111, null], ["BILLING_EXCEPTION", 12444, null]], "automatic tasks keep separate identities/amounts and incomplete choices");
  assert.ok((await prisma.dailyWorkEntry.findMany({ where: { id: { in: autoRows.map((e) => e.entryId) } } })).every((r) => r.todaysActual === null));
  latencyMs = 0;

  // Both CN representations must retain their individual Sunday/expiry rules after UNION batching.
  const cnRows = await createRows("batch-cn", 2);
  const cnData = { officerId: "so1", dealerId: "A", cnType: "RATE_DIFFERENCE", amount: 1000, acceptedAt: workDate, cnExpiryDays: 10, status: "ACCEPTED_NOT_POSTED", acceptanceReason: "PAYMENT_PENDING" };
  const request = await prisma.cnRequest.create({ data: { ...cnData, paymentTrackingMode: "TRACKED" } });
  const event = await prisma.cnPaymentEvent.create({ data: { cnRequestId: request.id, status: "NOT_PAID", eventDate: workDate, outstandingBefore: 1000, outstandingAfter: 1000, taskAmount: 1000, taskDate: workDate, taskStatus: "SCHEDULED", source: "TEST", requestKey: "batch-cn-event", recordedById: "so1", dailyWorkEntryId: cnRows[0].entryId, dailyWorkContribution: 1000 } });
  const legacy = await prisma.cnRequest.create({ data: { ...cnData, taskDate: workDate, legacyDailyWorkEntryId: cnRows[1].entryId, legacyDailyWorkContribution: 1000 } });
  const cnInputs = [{ entryId: cnRows[0].entryId, units: [{ unitType: "CN_PAYMENT", unitId: event.id, outcome: "RESCHEDULED", nextDate: day(21) }] }, { entryId: cnRows[1].entryId, units: [{ unitType: "CN_LEGACY", unitId: legacy.id, outcome: "RESCHEDULED", nextDate: day(21) }] }];
  // day(21) is a Wednesday; day(25) is Sunday and day(35) is past CN expiry.
  assert.equal((await send(cnInputs)).count, 2);
  for (const badDate of [day(25), day(35)]) assert.equal(await code(send(cnInputs.map((r) => ({ ...r, units: [{ ...r.units[0], nextDate: badDate }] })))), 422);
  eq((await prisma.dailyTaskOutcome.findMany({ where: { entryId: { in: cnRows.map((e) => e.entryId) } }, orderBy: { unitType: "asc" } })).map((o) => [o.unitType, dateOf(o.nextDate)]), [["CN_LEGACY", day(21)], ["CN_PAYMENT", day(21)]]);

  const one = await createRows("batch-one", 1), many = await createRows("batch-many", 20);
  latencyMs = 250; // all calls run through a REAL PostgreSQL transaction with its unchanged timeout
  statements.length = 0;
  await send(one);
  const oneTrips = statements.length;
  statements.length = 0;
  const start = performance.now();
  eq((await send(many)).count, 20);
  const elapsed = performance.now() - start;
  assert.equal(statements.length, oneTrips, "twenty tasks cost the same number of round trips as one");
  assert.ok(oneTrips <= 8, `cold save took ${oneTrips} statements`);
  assert.ok(elapsed < 5000, `slow-network save must finish inside the unchanged timeout: ${elapsed}ms`);
  eq((await prisma.dailyWorkEntry.findMany({ where: { id: { in: many.map((e) => e.entryId) } } })).map((r) => [Number(r.todaysActual), r.paymentMode]), Array.from({ length: 20 }, () => [800, "UPI"]));
  assert.equal(await prisma.dailyTaskOutcome.count({ where: { entryId: { in: many.map((e) => e.entryId) } } }), 20);
  latencyMs = 0;

  // Warm edits retain each task's snapshot and update only the chosen outcome; switching clears modes.
  await send(many.map((e, i) => ({ entryId: e.entryId, units: [{ ...e.units[0], outcome: i % 2 ? "RESCHEDULED" : "ABANDONED", actualAmount: 123, nextDate: day(21), reason: "Dealer closed this branch and requested no further collection visits" }] })));
  const warm = await prisma.dailyWorkEntry.findMany({ where: { id: { in: many.map((e) => e.entryId) } } });
  assert.ok(warm.every((r) => Number(r.todaysActual) === 0 && r.paymentMode === null));
  assert.equal(await prisma.dailyTaskOutcome.count({ where: { entryId: { in: many.map((e) => e.entryId) } } }), 20, "retries/editing never create duplicate task snapshots");
  assert.ok((await prisma.dailyTaskOutcome.findMany({ where: { entryId: { in: many.map((e) => e.entryId) } } })).every((o) => o.actualAmount === null && o.state === "DRAFT"));
  assert.equal(await prisma.calendarEntry.count({ where: { date: new Date(`${day(21)}T00:00:00Z`) } }), 0, "draft reschedules have no effects");

  // A bad later row rolls back the ENTIRE multi-row save, including previously valid edits.
  const snapshot = JSON.stringify(await prisma.dailyTaskOutcome.findMany({ where: { entryId: { in: many.map((e) => e.entryId) } }, orderBy: { id: "asc" } }));
  assert.equal(await code(send([many[0], { ...many[1], units: [{ ...many[1].units[0], actualAmount: 0 }] }])), 422);
  assert.equal(JSON.stringify(await prisma.dailyTaskOutcome.findMany({ where: { entryId: { in: many.map((e) => e.entryId) } }, orderBy: { id: "asc" } })), snapshot);
  failAudit = true;
  await assert.rejects(send(many), /test audit failure/, "a failure AFTER the bulk write must roll it all back");
  failAudit = false;
  assert.equal(JSON.stringify(await prisma.dailyTaskOutcome.findMany({ where: { entryId: { in: many.map((e) => e.entryId) } }, orderBy: { id: "asc" } })), snapshot);
  assert.ok((await prisma.dailyWorkEntry.findMany({ where: { id: { in: many.map((e) => e.entryId) } } })).every((r) => Number(r.todaysActual) === 0 && r.paymentMode === null));
  assert.equal(await code(send([{ ...many[0], units: [{ unitType: "MANUAL_ROW", unitId: many[1].entryId, outcome: "COMPLETED", actualAmount: 1 }] }])), 409, "task from another row is refused");
  const foreign = await prisma.dailyWorkEntry.create({ data: { officerId: "so2", dealerId: "A", rowKey: "foreign", workDate, batchId: "frozen", section: "RECOVERY", todaysPlan: 1000, status: "PLAN_SUBMITTED" } });
  assert.equal(await code(send([{ entryId: foreign.id, units: [{ unitType: "MANUAL_ROW", unitId: foreign.id, outcome: "COMPLETED", actualAmount: 20 }] }])), 409);
  assert.equal(await prisma.dailyTaskOutcome.count({ where: { entryId: foreign.id } }), 0);
  const beforeRetry = await prisma.dailyTaskOutcome.count({ where: { entryId: one[0].entryId } });
  await Promise.all([send(one), send(one)]);
  assert.equal(await prisma.dailyTaskOutcome.count({ where: { entryId: one[0].entryId } }), beforeRetry, "day lock serializes concurrent retries");
  await prisma.dailyWorkDay.update({ where: { officerId_workDate: { officerId: "so1", workDate } }, data: { status: "FINALIZED" } });
  assert.equal(await code(send(one)), 409, "final day lock still prevents writes");
  console.log(`batch draft regression — ${oneTrips} statements for 1 or 20 new tasks; 20 tasks with 250ms/call: ${Math.round(elapsed)}ms (default timeout 5000ms)`);
}

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "CalendarEntry","BillingExceptionTask","BillingException","DealerPaymentReceipt","DealerLastPayment","DailyTaskOutcome","DailyWorkEntry","DailyWorkDay","DealerAssignment","Dealer","AuditLog","Notification","TaskRescheduleEvent","User","UserGroup" CASCADE`);
  await prisma.userGroup.create({ data: { id: "g1", name: "MP" } });
  for (const [id, role] of [["admin", Role.SUPER_ADMIN], ["so1", Role.SALES_OFFICER], ["so2", Role.SALES_OFFICER], ["rm", Role.REGIONAL_MANAGER]] as const) await prisma.user.create({ data: { id, name: id.toUpperCase(), username: id, passwordHash: "x", role, groupId: id === "admin" ? null : "g1" } as never });
  for (const [id, name] of [["A", "Alpha Traders"], ["B", "Beta Stores"], ["C", "Gamma Agro"]] as const) {
    await prisma.dealer.create({ data: { id, name } });
    await prisma.dealerAssignment.create({ data: { dealerId: id, officerId: "so1", effectiveFrom: new Date("2024-01-01") } });
  }
  const D = day(0);
  setClock(D);
  await svc.saveDailyWork(so1, { section: "SALES", workDate: D, rows: [{ dealerId: "A", todaysPlan: 1000, entryType: "REGULAR" }, { dealerId: "B", todaysPlan: 2000, entryType: "REGULAR" }] });
  await svc.saveDailyWork(so1, { section: "RECOVERY", workDate: D, rows: [{ dealerId: "C", todaysPlan: 500, entryType: "REGULAR" }] });
  await noPlan(so1, D, ["APPOINTMENT", "VISITS", "OTHERS"]);
  await svc.submitDailyWorkDay(so1, { workDate: D });

  /* ---- a new report starts unselected; the row has no Actual and one identifiable task ---- */
  const A = await rowOf(so1, "SALES", D, "A"), B = await rowOf(so1, "SALES", D, "B"), C = await rowOf(so1, "RECOVERY", D, "C");
  for (const r of [A, B, C]) eq([r.tasks!.length, r.tasks![0]!.outcome, r.tasks![0]!.state, r.legacyOutcome], [1, null, "DRAFT", false], "starts at Select outcome");
  eq((await svc.getDailyWork(so1, "SALES", D, undefined, "REPORT")).rescheduledEntryIds, [], "nothing rescheduled yet");
  const baseline = await counts();

  /* ---- validation: nothing invalid is stored; a forged unit / another employee is refused ---- */
  assert.equal(await code(post(so1, "SALES", D, A, { outcome: "COMPLETED", actualAmount: 0 })), 422, "Completed with 0 is refused");
  assert.equal(await code(post(so1, "SALES", D, A, { outcome: "COMPLETED", actualAmount: -1 })), 422, "Completed with a negative is refused");
  assert.equal(await code(post(so1, "SALES", D, A, { outcome: "RESCHEDULED", nextDate: "2026-02-30" })), 422, "an impossible date is refused");
  assert.equal(await code(svc.enterTaskOutcomes(so1, { section: "SALES", workDate: D, entries: [{ entryId: A.entryId, units: [{ unitType: "MANUAL_ROW", unitId: "forged", outcome: "COMPLETED", actualAmount: 5 }] }] })), 409, "a task that is not in this row is refused");
  const forged = await code(svc.enterTaskOutcomes(so2, { section: "SALES", workDate: D, entries: [{ entryId: A.entryId, units: [{ unitType: "MANUAL_ROW", unitId: unitOf(A).unitId, outcome: "ABANDONED", reasonCode: "OTHER", reason: "Trying to abandon someone else's task here" }] }] }));
  assert.notEqual(forged, 0, "another employee cannot write outcomes to this row");
  eq(await counts(), baseline, "refused requests wrote nothing");

  /* ---- drafts: choices are saved, but nothing happens (no calendar task, no abandon, no finance) ---- */
  await post(so1, "SALES", D, A, { outcome: "COMPLETED", actualAmount: 800 });
  await post(so1, "SALES", D, B, { outcome: "RESCHEDULED", nextDate: day(1) });
  await post(so1, "RECOVERY", D, C, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "Dealer shut the shop for the season and asked us to stop visiting" });
  const draft = await counts();
  eq([draft.calendar, draft.events, draft.committed, draft.receipts], [0, 0, 0, 0], "drafts have no effect");
  assert.equal((await rowOf(so1, "SALES", D, "A")).tasks![0]!.actualAmount, 800);
  // changing the choice clears the other fields, and a draft can be changed freely
  await post(so1, "SALES", D, B, { outcome: "COMPLETED", actualAmount: 5, nextDate: day(2), reason: "stale stale stale stale stale" });
  const sw = (await rowOf(so1, "SALES", D, "B")).tasks![0]!;
  eq([sw.outcome, sw.actualAmount, sw.nextDate, sw.reason], ["COMPLETED", 5, null, null], "switching clears the other outcomes' fields");
  await post(so1, "SALES", D, B, { outcome: "RESCHEDULED", nextDate: day(1) });
  eq((await counts()).calendar, 0, "still nothing created");

  /* ---- final submission needs every applicable task to have a valid outcome ---- */
  await post(so1, "RECOVERY", D, C, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "too short" });
  assert.equal(await code(svc.submitDailyReport(so1, { workDate: D, selfRating: 7 })), 422, "an invalid Abandon reason blocks the report");
  eq([(await counts()).committed, (await counts()).calendar], [0, 0], "…and nothing was committed");
  await post(so1, "RECOVERY", D, C, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "Dealer shut the shop for the season and asked us to stop visiting" });
  await post(so1, "SALES", D, A, { outcome: null });
  assert.equal(await code(svc.submitDailyReport(so1, { workDate: D, selfRating: 7 })), 422, "an unselected task blocks the report");
  eq((await counts()).committed, 0);
  await post(so1, "SALES", D, A, { outcome: "COMPLETED", actualAmount: 800 });

  /* ---- successful submission: committed once, atomically ---- */
  assert.equal((await svc.submitDailyReport(so1, { workDate: D, selfRating: 7 })).ok, true);
  const after = await counts();
  eq([after.committed, after.calendar, after.events, after.receipts, after.exceptions, after.tasks], [3, 1, 1, 0, 0, 0], "3 outcomes committed; ONE continuing task; one history event; no finance records");
  const cont = await prisma.calendarEntry.findFirstOrThrow();
  eq([dateOf(cont.date), cont.taskSection, cont.dealerId, Number(cont.amount), cont.ownerId, cont.kind, cont.entryType], [day(1), "SALES", "B", 2000, "so1", "TASK", "REGULAR"], "same section, planned amount, dealer, owner on the next date");
  const rowA = (await prisma.dailyWorkEntry.findFirstOrThrow({ where: { section: "SALES", dealerId: "A", workDate: new Date(`${D}T00:00:00Z`) } }));
  eq([Number(rowA.todaysActual), rowA.status], [800, "FINALIZED"]);
  const rowB = await prisma.dailyWorkEntry.findFirstOrThrow({ where: { section: "SALES", dealerId: "B" } });
  eq([Number(rowB.todaysActual), Number(rowB.todaysPlan)], [0, 2000], "a rescheduled row reports 0 completed and keeps its planned amount");
  const oc = await prisma.dailyTaskOutcome.findMany({ orderBy: { section: "asc" } });
  const byD = Object.fromEntries(oc.map((o) => [o.entryId, o]));
  eq([byD[rowB.id]!.outcome, dateOf(byD[rowB.id]!.nextDate), byD[rowB.id]!.state, byD[rowB.id]!.continuedAsId], ["RESCHEDULED", day(1), "COMMITTED", cont.id]);
  const ab = oc.find((o) => o.outcome === "ABANDONED")!;
  eq([ab.state, ab.committedById, ab.reason, Number(ab.plannedAmount)], ["COMMITTED", "so1", "Dealer shut the shop for the season and asked us to stop visiting", 500], "abandon keeps reason, actor and the planned amount");
  const ev = await prisma.taskRescheduleEvent.findFirstOrThrow();
  eq([ev.sourceType, ev.sourceId, dateOf(ev.previousDate), dateOf(ev.newDate), ev.actorId], ["CALENDAR_ENTRY", cont.id, D, day(1), "so1"]);

  /* ---- retries / double clicks / refreshes produce nothing more ---- */
  assert.notEqual(await code(svc.submitDailyReport(so1, { workDate: D, selfRating: 7 })), 0, "a second submit is refused");
  assert.notEqual(await code(post(so1, "SALES", D, B, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "A later attempt to change a closed report" })), 0, "a submitted report accepts no outcome");
  eq(await counts(), after, "retries changed nothing");
  await assert.rejects(prisma.dailyTaskOutcome.update({ where: { id: ab.id }, data: { reason: "rewritten history of the abandonment" } }), "a committed outcome is immutable");
  await assert.rejects(prisma.dailyTaskOutcome.delete({ where: { id: ab.id } }), "…and cannot be deleted");
  eq(await counts(), after);
  eq((await svc.getDailyWork(so1, "SALES", D, undefined, "REPORT")).dealers.map((d) => d.tasks![0]!.state), ["COMMITTED", "COMMITTED"], "the finished report shows its committed outcomes");

  /* ---- the next day: the rescheduled task is there (once, badged, fresh outcome), and is rescheduled AGAIN, then abandoned ---- */
  const D1 = day(1);
  setClock(D1);
  await noPlan(so1, D1, ["APPOINTMENT", "VISITS", "OTHERS", "RECOVERY"]);
  const day1 = await svc.getDailyWork(so1, "SALES", D1, undefined, "PLAN");
  eq(day1.dealers.map((d) => [d.dealerId, d.todaysPlan]), [["B", 2000]], "the rescheduled task is in the same section's plan on its date, once, with its planned amount");
  await svc.getDailyWork(so1, "SALES", D1, undefined, "PLAN"); // a refresh never duplicates it
  eq(await prisma.dailyWorkEntry.count({ where: { workDate: new Date(`${D1}T00:00:00Z`), section: "SALES" } }), 1);
  await svc.submitDailyWorkDay(so1, { workDate: D1 });
  const b1 = await rowOf(so1, "SALES", D1, "B");
  eq([b1.tasks!.length, b1.tasks![0]!.outcome, b1.tasks![0]!.unitType, b1.tasks![0]!.unitId, b1.tasks![0]!.rescheduledFrom], [1, null, "CALENDAR_ENTRY", cont.id, D], "a fresh outcome is required; same task identity; Rescheduled-from badge data");
  assert.ok((await svc.getDailyWork(so1, "SALES", D1, undefined, "REPORT")).rescheduledEntryIds.includes(b1.entryId), "the row carries the Rescheduled badge");
  eq((await svc.getDailyWork(so1, "SALES", D1, undefined, "REPORT")).rescheduleCounts[b1.entryId], 1, "one recorded move → the count circle shows 1");
  eq((await svc.getDailyWork(so1, "SALES", D1, undefined, "REPORT")).rescheduleCounts[b1.entryId], 1, "a refresh / re-read does not change it");

  // reschedule again (from the calendar task itself), twice over
  await post(so1, "SALES", D1, b1, { outcome: "RESCHEDULED", nextDate: day(3) });
  assert.equal((await svc.submitDailyReport(so1, { workDate: D1, selfRating: 7 })).ok, true);
  const moved = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: cont.id } });
  eq([dateOf(moved.date), Number(moved.amount), moved.taskSection, await prisma.calendarEntry.count()], [day(3), 2000, "SALES", 1], "the SAME task moved again — no second copy");
  const D3 = day(3);
  setClock(D3);
  await noPlan(so1, D3, ["APPOINTMENT", "VISITS", "OTHERS", "RECOVERY"]);
  await svc.getDailyWork(so1, "SALES", D3, undefined, "PLAN");
  await svc.submitDailyWorkDay(so1, { workDate: D3 });
  const b3 = await rowOf(so1, "SALES", D3, "B");
  eq([b3.tasks![0]!.unitId, b3.tasks![0]!.rescheduledFrom], [cont.id, D1]);
  eq((await svc.getDailyWork(so1, "SALES", D3, undefined, "REPORT")).rescheduleCounts[b3.entryId], 2, "the same task moved twice → 2, carried to its new date and Daily Work row");
  // Abandon on the final day: reason required, then the task never comes back
  await post(so1, "SALES", D3, b3, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "...................................." }); // a draft may hold an incomplete choice
  assert.equal(await code(svc.submitDailyReport(so1, { workDate: D3, selfRating: 7 })), 422, "a meaningless reason blocks the report");
  assert.equal((await prisma.calendarEntry.findUniqueOrThrow({ where: { id: cont.id } })).abandonedAt, null, "…and nothing was abandoned");
  await post(so1, "SALES", D3, b3, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "Dealer closed the account and moved to another distributor" });
  assert.equal((await svc.submitDailyReport(so1, { workDate: D3, selfRating: 7 })).ok, true);
  const ended = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: cont.id } });
  assert.ok(ended.abandonedAt, "the task is marked abandoned");
  for (const n of [4, 5]) {
    setClock(day(n));
    await svc.getDailyWork(so1, "SALES", day(n), undefined, "PLAN");
    eq(await prisma.dailyWorkEntry.count({ where: { workDate: new Date(`${day(n)}T00:00:00Z`), section: "SALES" } }), 0, "an abandoned task is never scheduled again");
  }
  eq((await prisma.taskRescheduleEvent.findMany({ where: { sourceId: cont.id }, orderBy: { createdAt: "asc" } })).map((e) => [dateOf(e.previousDate), dateOf(e.newDate)]), [[D, day(1)], [day(1), day(3)]], "every reschedule is kept: previous / next date");
  /* ---- Performance → View: the review detail follows the task by its stable identity across the successive moves (read-only) ---- */
  {
    const reviewOf = async (date: string) => svc.getDailyWorkReviewDetail(so1, "so1", date);
    const eventsBefore = await prisma.taskRescheduleEvent.count(), outcomesBefore = await prisma.dailyTaskOutcome.count(), entriesBefore = await prisma.dailyWorkEntry.count();
    const r0 = await reviewOf(D), rowB0 = r0.sales.dealers.find((d) => d.dealerId === "B")!;
    const m0 = r0.rescheduling.rows[rowB0.entryId]!;
    eq([m0.length, m0[0]!.from, m0[0]!.to, m0[0]!.count], [1, null, day(1), 2], "the original date keeps the evidence that the manual task moved to the next day (continued as a Calendar task); lifetime count 2");
    eq([Number(rowB0.todaysPlan), Number(rowB0.todaysActual ?? 0)], [2000, 0], "the saved planned amount and a 0 actual are untouched, and a reschedule implies no completion");
    const r1 = await reviewOf(day(1)), m1 = Object.values(r1.rescheduling.rows).flat();
    eq(m1.map((m) => [m.key, m.from, m.to, m.count]), [[`CALENDAR_ENTRY:${cont.id}`, D, day(3), 2]], "the middle date shows both the arrival and the onward move");
    const r3 = await reviewOf(day(3)), m3 = Object.values(r3.rescheduling.rows).flat();
    eq(m3.map((m) => [m.from, m.to, m.count]), [[day(1), null, 2]], "the last date shows only the arrival from the previous date");
    eq(Object.values(r0.rescheduling.rows).flat().length + r0.rescheduling.tasks.length, 1, "the task appears once on the original date (table OR history-only, never both)");
    // Actions are keyed by the day the change was MADE (real time here), and agree with Performance's reschedule figure for that day.
    const rs = load<typeof import("./reschedule-review.server")>("src/features/daily-work/reschedule-review.server.ts");
    const madeToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const todays = await rs.loadReschedulingReview("so1", madeToday, []);
    const dbCount = await prisma.taskRescheduleEvent.count({ where: { ownerId: "so1" } });
    eq(todays.actions.length, dbCount, "every recorded date change made that day is listed (two moves of one task → two events)");
    eq(todays.actions.map((a) => [a.previousDate, a.newDate]), [[D, day(1)], [day(1), day(3)]], "previous and new scheduled dates per event");
    assert.ok(todays.actions.every((a) => a.actorName && a.createdAt), "the person and the time are present");
    eq((await rs.loadReschedulingReview("so1", day(1), [])).actions.length, 0, "a scheduled date on which nothing was changed lists no actions");
    eq(await code(svc.getDailyWorkReviewDetail(so2, "so1", D)), 403, "another Sales Officer cannot open the detail");
    eq([await prisma.taskRescheduleEvent.count(), await prisma.dailyTaskOutcome.count(), await prisma.dailyWorkEntry.count()], [eventsBefore, outcomesBefore, entriesBefore], "opening the detail wrote nothing");
  }
  const fin = await counts();
  eq([fin.receipts, fin.exceptions, fin.tasks], [0, 0, 0], "no finance record was created by any outcome");
  /* ---- Performance → Tasks agrees: one task (deduplicated), Abandoned as its own status, full timeline ---- */
  const ana = load<typeof import("@/features/tasks/task-analysis.server")>("src/features/tasks/task-analysis.server.ts");
  const person = (id: string) => ({ id, name: id.toUpperCase(), role: "SALES_OFFICER", groupId: "g1", groupName: "MP" });
  const scope = { population: [person("so1")], officers: [], states: [] };
  const base = { from: day(-5), to: day(10), basis: "ORIGINAL" as const, type: "ALL" as const, section: "", source: "", status: "", focusDate: null, page: 1, pageSize: 100 };
  const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const all = plain(await ana.getTaskAnalysis(scope as never, base));
  const abandonedRows = plain(await ana.getTaskAnalysis(scope as never, { ...base, status: "ABANDONED" })).rows;
  eq(abandonedRows.map((r: { section: string }) => r.section).sort(), ["RECOVERY", "SALES"], "the Abandoned status filter finds exactly the two abandoned tasks (Recovery row C, Sales task B)");
  eq([abandonedRows.every((r: { status: string }) => r.status === "ABANDONED"), all.summary.abandoned], [true, 2], "Abandoned is its own status and summary figure");
  {
    const dates = all.rows.map((r: { originalDate: string }) => r.originalDate);
    eq(dates, [...dates].sort().reverse(), "Original Due Date basis: newest scheduled date first");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const moved = plain(await ana.getTaskAnalysis(scope as never, { ...base, from: today, to: today, basis: "RESCHEDULED_ON" as never, status: "" }));
    const gone = plain(await ana.getTaskAnalysis(scope as never, { ...base, from: today, to: today, basis: "ABANDONED_ON" as never, status: "" }));
    eq([moved.rows.length > 0, gone.rows.length > 0, moved.totalRows === moved.rows.length], [true, true, true], "the Rescheduled On and Abandoned On lists load with their event-date ordering and keep one row per task");
    eq(new Set(moved.rows.map((r: { key: string }) => r.key)).size, moved.rows.length, "no task is duplicated when several events match");
  }
  eq(all.rows.filter((r: { taskId: string }) => r.taskId === cont.id).length, 1, "the repeatedly rescheduled task is ONE row, not one per occurrence");
  const hist = plain(await ana.getTaskHistory(scope as never, "CALENDAR_ENTRY", cont.id));
  eq([hist.events.length, hist.outcomes.map((o: { outcome: string }) => o.outcome)], [2, ["RESCHEDULED", "RESCHEDULED", "ABANDONED"]], "history: both reschedules, then the abandonment (reason, actor, time kept)");
  assert.equal(hist.outcomes[2].reason, "Dealer closed the account and moved to another distributor");
  const madeOn = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // outcomes were committed "now" in real time
  const act = await ana.getTaskActivity(scope as never, madeOn, madeOn);
  eq([act.get(`so1|${madeOn}`)?.abandoned, act.get(`so1|${madeOn}`)?.reschedules], [2, 2], "Task Activity counts abandonments and reschedules on the business date they were made");
  await batchDraftRegression();
  /* ---- structured abandonment reasons: category per section, text only for Other, persisted, shown, no finance effect ---- */
  {
    const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
    const R = day(8);
    setClock(R);
    await prisma.dailyWorkEntry.deleteMany({ where: { workDate: new Date(`${R}T00:00:00Z`) } });
    await svc.saveDailyWork(so1, { section: "SALES", workDate: R, rows: [{ dealerId: "A", todaysPlan: 400, entryType: "REGULAR" }, { dealerId: "B", todaysPlan: 500, entryType: "REGULAR" }, { dealerId: "C", todaysPlan: 600, entryType: "REGULAR" }] });
    await svc.saveDailyWork(so1, { section: "RECOVERY", workDate: R, rows: [{ dealerId: "A", todaysPlan: 700, entryType: "REGULAR" }, { dealerId: "B", todaysPlan: 800, entryType: "REGULAR" }] });
    await noPlan(so1, R, ["APPOINTMENT", "VISITS", "OTHERS"]);
    await svc.submitDailyWorkDay(so1, { workDate: R });
    const sa = await rowOf(so1, "SALES", R, "A"), sb = await rowOf(so1, "SALES", R, "B"), sc = await rowOf(so1, "SALES", R, "C"), ra = await rowOf(so1, "RECOVERY", R, "A"), rb = await rowOf(so1, "RECOVERY", R, "B");
    const receipts = await prisma.dealerPaymentReceipt.count();
    // Section rules: a Recovery code is refused for Sales and vice versa; an unknown code is refused.
    assert.equal(await code(post(so1, "SALES", R, sa, { outcome: "ABANDONED", reasonCode: "NO_DUES" })), 422, "Sales refuses a Recovery reason");
    assert.equal(await code(post(so1, "RECOVERY", R, ra, { outcome: "ABANDONED", reasonCode: "DEALER_REFUSED" })), 422, "Recovery refuses a Sales reason");
    assert.equal(await code(post(so1, "RECOVERY", R, ra, { outcome: "ABANDONED", reasonCode: "PRODUCT_UNAVAILABLE" })), 422);
    assert.equal(await code(post(so1, "SALES", R, sa, { outcome: "ABANDONED", reasonCode: "made-up" })), 422);
    // Drafts: every category is saved and reloads; text is kept only for Other.
    await post(so1, "SALES", R, sa, { outcome: "ABANDONED", reasonCode: "PRODUCT_UNAVAILABLE", reason: "stale text that must not be kept" });
    await post(so1, "SALES", R, sb, { outcome: "ABANDONED", reasonCode: "DEALER_REFUSED" });
    await post(so1, "SALES", R, sc, { outcome: "ABANDONED", reasonCode: "OTHER" }); // incomplete (no explanation yet) — a draft may be saved
    await post(so1, "RECOVERY", R, ra, { outcome: "ABANDONED", reasonCode: "NO_DUES" });
    await post(so1, "RECOVERY", R, rb, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "   " });
    const draft = async (section: "SALES" | "RECOVERY", dealerId: string) => { const t = (await rowOf(so1, section, R, dealerId)).tasks![0]!; return [t.outcome, t.reasonCode, t.reason, t.state]; };
    same(await draft("SALES", "A"), ["ABANDONED", "PRODUCT_UNAVAILABLE", null, "DRAFT"], "details of a predefined reason are cleared");
    same(await draft("SALES", "C"), ["ABANDONED", "OTHER", null, "DRAFT"]);
    // Final submission needs a category and, for Other, a meaningful explanation (the existing free-text rules).
    assert.equal(await code(svc.submitDailyReport(so1, { workDate: R, selfRating: 7 })), 422, "Other without an explanation blocks the report");
    await post(so1, "SALES", R, sc, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "short" });
    assert.equal(await code(svc.submitDailyReport(so1, { workDate: R, selfRating: 7 })), 422, "…and a too-short one");
    await post(so1, "SALES", R, sc, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "Dealer has stopped trading in this product line" });
    await post(so1, "RECOVERY", R, rb, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "Dealer disputes the invoice and asked us to wait" });
    // Switching the outcome or the category clears what no longer applies.
    await post(so1, "SALES", R, sa, { outcome: "COMPLETED", actualAmount: 100, reasonCode: "OTHER", reason: "leftover" });
    same(await draft("SALES", "A"), ["COMPLETED", null, null, "DRAFT"], "leaving Abandon clears the abandonment fields");
    await post(so1, "SALES", R, sa, { outcome: "ABANDONED", reasonCode: "PRODUCT_UNAVAILABLE" });
    // An Other explanation is replaced by a predefined category without leftovers (database check would refuse them).
    await post(so1, "SALES", R, sc, { outcome: "ABANDONED", reasonCode: "DEALER_REFUSED", reason: "Dealer has stopped trading in this product line" });
    same(await draft("SALES", "C"), ["ABANDONED", "DEALER_REFUSED", null, "DRAFT"], "changing away from Other clears the details");
    await post(so1, "SALES", R, sc, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "Dealer has stopped trading in this product line" });
    const unchanged = await counts();
    assert.equal((await svc.submitDailyReport(so1, { workDate: R, selfRating: 7 })).ok, true);
    const done = await prisma.dailyTaskOutcome.findMany({ where: { workDate: new Date(`${R}T00:00:00Z`), state: "COMMITTED" }, orderBy: [{ section: "asc" }, { plannedAmount: "asc" }] });
    same(done.map((o) => [o.section, o.reasonCode, o.reason]), [["RECOVERY", "NO_DUES", null], ["RECOVERY", "OTHER", "Dealer disputes the invoice and asked us to wait"], ["SALES", "PRODUCT_UNAVAILABLE", null], ["SALES", "DEALER_REFUSED", null], ["SALES", "OTHER", "Dealer has stopped trading in this product line"]], "the chosen category and the optional explanation are persisted");
    assert.equal(await prisma.dealerPaymentReceipt.count(), receipts, "No Dues records the reason only: no payment, write-off or resolution");
    same([(await counts()).exceptions, (await counts()).tasks], [unchanged.exceptions, unchanged.tasks]);
    // The database refuses a code that does not belong to the section, and a committed predefined reason with text.
    await assert.rejects(prisma.$executeRawUnsafe(`INSERT INTO "DailyTaskOutcome" ("id","entryId","unitType","unitId","officerId","workDate","section","plannedAmount","outcome","reasonCode","state","committedAt","updatedAt") SELECT 'x1', "entryId", 'MANUAL_ROW', 'x1', "officerId", "workDate", 'SALES', 1, 'ABANDONED', 'NO_DUES', 'COMMITTED', NOW(), NOW() FROM "DailyTaskOutcome" LIMIT 1`), "NO_DUES is not a Sales reason (database check)");
    // Performance → Tasks shows the category; a historical free-text abandonment stays readable with no category.
    const ana = load<typeof import("@/features/tasks/task-analysis.server")>("src/features/tasks/task-analysis.server.ts");
    const person = { id: "so1", name: "SO1", role: "SALES_OFFICER", groupId: "g1", groupName: "MP" };
    const scope = { population: [person], officers: [], states: [] } as never;
    const old = day(9);
    const oldRow = await prisma.dailyWorkEntry.create({ data: { officerId: "so1", dealerId: "A", rowKey: "A", workDate: new Date(`${old}T00:00:00Z`), batchId: "legacy", section: "SALES", todaysPlan: 50, todaysActual: 0, status: "FINALIZED", planSubmittedAt: new Date() } });
    await prisma.dailyTaskOutcome.create({ data: { entryId: oldRow.id, unitType: "MANUAL_ROW", unitId: oldRow.id, officerId: "so1", workDate: new Date(`${old}T00:00:00Z`), section: "SALES", plannedAmount: 50, outcome: "ABANDONED", reason: "Written before categories existed, kept as typed", state: "COMMITTED", committedAt: new Date(), committedById: "so1", committedByName: "SO1" } as never });
    await prisma.dailyWorkDay.create({ data: { officerId: "so1", workDate: new Date(`${old}T00:00:00Z`), currentBatchId: "legacy-next", status: "FINALIZED", finalizedAt: new Date() } });
    const f = { from: R, to: old, basis: "ORIGINAL" as const, type: "ALL" as const, section: "", source: "", status: "ABANDONED", focusDate: null, page: 1, pageSize: 100 };
    const listed = JSON.parse(JSON.stringify(await ana.getTaskAnalysis(scope, f))) as { summary: { abandoned: number }; rows: { section: string; status: string; abandonReasonCode: string | null; abandonReason: string | null; key: string; sourceType: string; taskId: string }[] };
    same(listed.rows.map((r) => [r.section, r.abandonReasonCode, r.abandonReason]).sort(), [["RECOVERY", "NO_DUES", null], ["RECOVERY", "OTHER", "Dealer disputes the invoice and asked us to wait"], ["SALES", "DEALER_REFUSED", null], ["SALES", "OTHER", "Dealer has stopped trading in this product line"], ["SALES", "PRODUCT_UNAVAILABLE", null], ["SALES", null, "Written before categories existed, kept as typed"]].sort(), "the Tasks list carries the saved category / explanation; the historical record has only its text");
    assert.equal(listed.summary.abandoned, 6, "abandoned counts unchanged (counted only after the successful submission)");
    const legacyTask = listed.rows.find((r) => r.abandonReasonCode === null)!;
    const hist = JSON.parse(JSON.stringify(await ana.getTaskHistory(scope, legacyTask.sourceType, legacyTask.taskId))) as { outcomes: { outcome: string; reasonCode: string | null; reason: string | null; committedByName: string | null }[] };
    same(hist.outcomes.map((o) => [o.outcome, o.reasonCode, o.reason, o.committedByName]), [["ABANDONED", null, "Written before categories existed, kept as typed", "SO1"]], "history keeps the legacy text, the actor and the time");
    const cat = listed.rows.find((r) => r.abandonReasonCode === "PRODUCT_UNAVAILABLE")!;
    same(JSON.parse(JSON.stringify((await ana.getTaskHistory(scope, cat.sourceType, cat.taskId)).outcomes.map((o) => [o.outcome, o.reasonCode, o.reason, o.committedByName]))), [["ABANDONED", "PRODUCT_UNAVAILABLE", null, "SO1"]]);
  }
  console.log("task-outcome.integration.ts — all scenarios passed");
}
main().then(async () => { await prisma.$disconnect(); }, async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
