/**
 * ONE ROW PER DISTINCT TASK against a REAL, disposable PostgreSQL database: two same-dealer tasks stay two rows through materialization, the plan, the report (each with its own
 * outcome), rescheduling and Performance; the dealer's ONE directly entered manual task is independent per section; historical combined draft rows are separated exactly from their links.
 *
 *   BILLING_TASK_TEST_URL=postgresql://localhost:5432/billing_task_test npm run test:task-rows:db
 */
import assert from "node:assert/strict";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import * as realDailyWork from "@/lib/daily-work";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";
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
const dw = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => ({}) },
  "@/lib/daily-work": { ...realDailyWork, currentBusinessDate: (d?: Date) => (d ? realDailyWork.currentBusinessDate(d) : clock) },
  "@/lib/scope": { getCurrentOwnerByDealer: async (ids: string[]) => { const rows = await prisma.dealerAssignment.findMany({ where: { dealerId: { in: ids }, effectiveTo: null }, orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }] }); return new Map(rows.map((r) => [r.dealerId, r.officerId])); }, getCurrentDealerIds: async (id: string) => (await prisma.dealerAssignment.findMany({ where: { officerId: id } })).map((a) => a.dealerId), getOfficerScope: async (c: AuthContext) => ({ all: false, ids: [c.userId] }), assertOfficerInScope: async () => undefined },
  "@/features/labels/service.server": { getResolvedLabels: async () => DEFAULT_LABELS },
  "@/features/schemes/scheme-planning.server": { runningSchemes: async () => [] },
  "@/features/planning/monthly.server": { getMonthly: async () => ({ monthlyMode: "PACK_SIZE", months: [], dealers: [] }) },
  "@/features/planning/monthly-plan.server": { resolveAddableSeasonalPlanId: async () => null },
  "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => 0, latestCnRequestStatusByDealer: async () => new Map() },
  "@/lib/recovery-config": { getAutoTasksEnabled: async () => false, getCalendarEnabled: async () => true },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map(), resolveDealerDisplayNames: async () => new Map(), decorateDealerNames: async (r: unknown[]) => r, dealerDisplayName: (n: string) => n },
  "./auto-task-materialization.server": { materializeDueDailyWorkTasks: async () => ({}), materializeDueDailyWorkTasksInTransaction: async () => ({}), autoTasksApplyToRole: () => true },
});
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


const rowsOf = async (section: "SALES" | "RECOVERY", date: string, mode: "PLAN" | "REPORT" = "PLAN") => (await svc.getDailyWork(so1, section, date, undefined, mode)).dealers;
const brief = (rows: Awaited<ReturnType<typeof rowsOf>>) => rows.map((r) => `${r.dealerId}:${r.rowKind}:${r.todaysPlan}`).sort();
const cal = (data: Record<string, unknown>) => prisma.calendarEntry.create({ data: { ownerId: "so1", kind: "TASK", ...data } as never });

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
  const dDate = new Date(`${D}T00:00:00Z`);

  /* ---- scheduled tasks: two same-dealer Recovery tasks and a Sales task; plus two HISTORICAL combined draft rows (their sources still carry the links) ---- */
  const r1 = await cal({ date: dDate, taskSection: "RECOVERY", dealerId: "A", amount: 12444, entryType: "REGULAR" });
  const r2 = await cal({ date: dDate, taskSection: "RECOVERY", dealerId: "A", amount: 11111, entryType: "REGULAR" });
  const s1 = await cal({ date: dDate, taskSection: "SALES", dealerId: "A", amount: 700, entryType: "REGULAR" });
  await prisma.dailyWorkDay.create({ data: { officerId: "so1", workDate: dDate, currentBatchId: batch("so1", D), status: "OPEN" } });
  const combined = async (dealerId: string, plan: number, parts: number[]) => {
    const row = await prisma.dailyWorkEntry.create({ data: { officerId: "so1", dealerId, rowKey: dealerId, workDate: dDate, batchId: batch("so1", D), section: "RECOVERY", todaysPlan: plan, status: "DRAFT" } });
    const ids: string[] = [];
    for (const amount of parts) ids.push((await cal({ date: dDate, taskSection: "RECOVERY", dealerId, amount, entryType: "REGULAR", dailyWorkEntryId: row.id, dailyWorkContribution: amount, materializedAt: new Date() })).id);
    return { row, ids };
  };
  const legacyB = await combined("B", 8000, [3000, 2000]); // 3,000 manual on top
  const legacyC = await combined("C", 4000, [1000, 3000]); // nothing manual on top

  /* ---- 1. Daily Plan: one row per task; the legacy combined rows are separated from their own links ---- */
  const plan1 = await rowsOf("RECOVERY", D);
  eq(brief(plan1), ["A:TASK:11111", "A:TASK:12444", "B:MANUAL:3000", "B:TASK:2000", "B:TASK:3000", "C:TASK:1000", "C:TASK:3000"], "same-dealer tasks keep their original amounts as separate rows; the combined rows were split exactly by their links");
  assert.equal(plan1.filter((r) => r.dealerId === "C" && r.rowKind === "TASK").some((r) => r.entryId === legacyC.row.id), true, "a combined row with nothing manual on top becomes its first task's row (stable id)");
  const links = await prisma.calendarEntry.findMany({ where: { taskSection: "RECOVERY" } });
  assert.ok(links.every((c) => c.dailyWorkEntryId && Number(c.dailyWorkContribution) === Number(c.amount)), "every Calendar task is linked to a row carrying exactly its own amount");
  eq(await prisma.dailyWorkEntry.count({ where: { officerId: "so1", workDate: dDate, section: "RECOVERY", rowKey: { startsWith: "t:CAL:" } } }), 6);
  const manualB = plan1.find((r) => r.dealerId === "B" && r.rowKind === "MANUAL")!;
  eq(manualB.entryId, legacyB.row.id, "the manual remainder stays on the original row");
  // Reload / concurrency / retries: nothing is duplicated.
  const reads = await Promise.all([rowsOf("RECOVERY", D), rowsOf("RECOVERY", D), rowsOf("RECOVERY", D)]);
  for (const r of [...reads, await rowsOf("RECOVERY", D)]) eq(brief(r), brief(plan1), "reloading creates no duplicate rows");
  eq(await prisma.dailyWorkEntry.count({ where: { officerId: "so1", workDate: dDate, section: "RECOVERY" } }), 7);

  /* ---- 2. The dealer stays selectable and gets ONE directly entered task per section ---- */
  assert.ok((await svc.getDailyWork(so1, "RECOVERY", D, undefined, "PLAN")).availableDealers.some((d) => d.id === "A"), "A has only scheduled tasks → still in Add Dealer");
  await svc.saveDailyWork(so1, { section: "RECOVERY", workDate: D, rows: [{ dealerId: "A", todaysPlan: 5000, entryType: "REGULAR" }, { dealerId: "B", todaysPlan: 3000, entryType: "REGULAR" }] });
  await svc.saveDailyWork(so1, { section: "SALES", workDate: D, rows: [{ dealerId: "A", todaysPlan: 300, entryType: "REGULAR" }] });
  const rec = await rowsOf("RECOVERY", D), sal = await rowsOf("SALES", D);
  eq(brief(rec).filter((x) => x.startsWith("A:")), ["A:MANUAL:5000", "A:TASK:11111", "A:TASK:12444"], "Recovery: 12,444 + 11,111 scheduled + one directly entered 5,000 = three rows");
  eq(brief(sal), ["A:MANUAL:300", "A:TASK:700"], "Sales is independent: its own manual row next to the Sales task");
  eq([rec.filter((r) => r.dealerId === "A").length, new Set(rec.map((r) => r.dealerId)).size], [3, 3], "3 rows / 1 dealer for A");
  assert.equal(await code(svc.saveDailyWork(so1, { section: "RECOVERY", workDate: D, rows: [{ dealerId: "A", todaysPlan: 1, entryType: "REGULAR" }, { dealerId: "A", todaysPlan: 2, entryType: "REGULAR" }] })), 422);
  const before = await prisma.dailyWorkEntry.count();
  await svc.saveDailyWork(so1, { section: "RECOVERY", workDate: D, rows: [{ dealerId: "B", todaysPlan: 3000, entryType: "REGULAR" }] }); // the editor removes the manual A row
  eq(brief(await rowsOf("RECOVERY", D)).filter((x) => x.startsWith("A:")), ["A:TASK:11111", "A:TASK:12444"], "deleting the manual draft removes only that row");
  assert.equal(await prisma.dailyWorkEntry.count(), before - 1);
  await svc.saveDailyWork(so1, { section: "RECOVERY", workDate: D, rows: [{ dealerId: "A", todaysPlan: 5000, entryType: "REGULAR" }, { dealerId: "B", todaysPlan: 3000, entryType: "REGULAR" }] });

  /* ---- 3. Submit the plan; the limit spans planning batches; then the REPORT: each row is its own task with its own outcome ---- */
  await noPlan(so1, D, ["APPOINTMENT", "VISITS", "OTHERS"]);
  await svc.submitDailyWorkDay(so1, { workDate: D });
  eq(await Promise.all([1, 2, 3].map(() => code(svc.saveDailyWork(so1, { section: "RECOVERY", workDate: D, rows: [{ dealerId: "A", todaysPlan: 9, entryType: "REGULAR" }] })))), [409, 409, 409], "a second directly entered A task is rejected after submission, concurrent or not");
  eq((await svc.getDailyWork(so1, "RECOVERY", D, undefined, "PLAN")).availableDealers.some((d) => d.id === "A"), false);
  const repRec = await rowsOf("RECOVERY", D, "REPORT"), repSales = await rowsOf("SALES", D, "REPORT");
  assert.ok([...repRec, ...repSales].every((r) => (r.tasks ?? []).length === 1), "every row is exactly one task (one unit)");
  const byPlan = (rows: typeof repRec, dealerId: string, plan: number) => rows.find((r) => r.dealerId === dealerId && r.todaysPlan === plan)!;
  const A1 = byPlan(repRec, "A", 12444), A2 = byPlan(repRec, "A", 11111), AM = byPlan(repRec, "A", 5000), SM = byPlan(repSales, "A", 300), S1 = byPlan(repSales, "A", 700);
  eq([A1.tasks![0]!.unitType, A2.tasks![0]!.unitType, AM.tasks![0]!.unitType], ["CALENDAR_ENTRY", "CALENDAR_ENTRY", "MANUAL_ROW"]);
  const unit = (r: typeof A1, f: Record<string, unknown>) => ({ unitType: r.tasks![0]!.unitType, unitId: r.tasks![0]!.unitId, ...f });
  // Draft a different outcome on every row; a row's outcome never leaks into its siblings.
  await svc.enterTaskOutcomes(so1, { section: "RECOVERY", workDate: D, entries: [
    { entryId: A1.entryId, paymentMode: "UPI", units: [unit(A1, { outcome: "COMPLETED", actualAmount: 12444 })] },
    { entryId: A2.entryId, units: [unit(A2, { outcome: "RESCHEDULED", nextDate: day(1) })] },
    { entryId: AM.entryId, units: [unit(AM, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "Dealer closed the account for the season" })] },
    ...repRec.filter((r) => r.dealerId !== "A").map((r) => ({ entryId: r.entryId, paymentMode: "UPI", units: [unit(r, { outcome: "COMPLETED", actualAmount: r.todaysPlan })] })),
  ] });
  await svc.enterTaskOutcomes(so1, { section: "SALES", workDate: D, entries: [
    { entryId: S1.entryId, units: [unit(S1, { outcome: "COMPLETED", actualAmount: 700 })] },
    { entryId: SM.entryId, units: [unit(SM, { outcome: "RESCHEDULED", nextDate: day(2) })] },
  ] });
  // Drafts: nothing is rescheduled, abandoned or created yet.
  const noEffect = { calendar: await prisma.calendarEntry.count(), events: await prisma.taskRescheduleEvent.count(), committed: await prisma.dailyTaskOutcome.count({ where: { state: "COMMITTED" } }) };
  eq(noEffect, { calendar: 7, events: 0, committed: 0 }, "drafts have no effect");
  const actualOf = async (id: string) => Number((await prisma.dailyWorkEntry.findUniqueOrThrow({ where: { id } })).todaysActual);
  eq([await actualOf(A1.entryId), await actualOf(A2.entryId), await actualOf(AM.entryId)], [12444, 0, 0], "each row's Actual is derived from its OWN task only");
  // A forged unit of ANOTHER row inside this row's entry is refused: outcomes bind to the row's own task identity.
  assert.equal(await code(svc.enterTaskOutcomes(so1, { section: "RECOVERY", workDate: D, entries: [{ entryId: A1.entryId, units: [unit(A2, { outcome: "COMPLETED", actualAmount: 5 })] }] })), 409, "a sibling task's identity cannot be used on this row");
  assert.notEqual(await code(svc.enterTaskOutcomes(so2, { section: "RECOVERY", workDate: D, entries: [{ entryId: A1.entryId, units: [unit(A1, { outcome: "ABANDONED", reasonCode: "OTHER", reason: "Someone else abandoning this task now" })] }] })), 0, "another employee cannot change it");

  /* ---- 4. Submit the report: ONLY the rescheduled row's task moves; the others (same dealer) stay ---- */
  assert.equal((await svc.submitDailyReport(so1, { workDate: D, selfRating: 8 })).ok, true);
  const dateOfCal = async (id: string) => dateOf((await prisma.calendarEntry.findUniqueOrThrow({ where: { id } })).date);
  eq([await dateOfCal(r1.id), await dateOfCal(r2.id), await dateOfCal(s1.id)], [D, day(1), D], "only the second same-dealer task moved to its next date");
  const moved = await prisma.taskRescheduleEvent.findMany({ orderBy: { createdAt: "asc" } });
  eq(moved.map((e) => [e.sourceType, e.sourceId === r2.id ? "r2" : "continued", dateOf(e.previousDate), dateOf(e.newDate)]), [["CALENDAR_ENTRY", "r2", D, day(1)], ["CALENDAR_ENTRY", "continued", D, day(2)]], "each reschedule is recorded for its own task");
  const outcomes = await prisma.dailyTaskOutcome.findMany({ where: { state: "COMMITTED" } });
  eq(outcomes.length, 10, "every row's task has its own committed outcome");
  const ab = outcomes.find((o) => o.outcome === "ABANDONED")!;
  eq([ab.entryId, ab.reason, Number(ab.plannedAmount)], [AM.entryId, "Dealer closed the account for the season", 5000], "the abandonment belongs to the manual A task only");
  eq(await prisma.calendarEntry.count({ where: { taskSection: "SALES", date: new Date(`${day(2)}T00:00:00Z`), amount: 300 } }), 1, "the Sales manual task continues once, in Sales, with its planned amount");
  assert.equal(await prisma.calendarEntry.count({ where: { taskSection: "RECOVERY", abandonedAt: { not: null } } }), 0, "no scheduled task was abandoned");

  /* ---- 5. The next day: the moved task is back once, in its own row with a Rescheduled flag; the dealer is selectable ---- */
  setClock(day(1));
  const next = await svc.getDailyWork(so1, "RECOVERY", day(1), undefined, "PLAN");
  await svc.getDailyWork(so1, "RECOVERY", day(1), undefined, "PLAN");
  eq(brief(next.dealers), ["A:TASK:11111"], "the rescheduled task returns once, with its original planned amount, as its own Recovery row");
  assert.ok(next.rescheduledEntryIds.includes(next.dealers[0]!.entryId), "…flagged Rescheduled");
  assert.ok(next.availableDealers.some((d) => d.id === "A"), "…and the dealer can still get a directly entered task that day");
  eq(next.dealers[0]!.tasks ?? [], [], "plan rows carry no outcomes");

  /* ---- 6. Performance → Tasks and Task Activity keep the tasks separate ---- */
  const ana = load<typeof import("@/features/tasks/task-analysis.server")>("src/features/tasks/task-analysis.server.ts");
  const person = { id: "so1", name: "SO1", role: "SALES_OFFICER", groupId: "g1", groupName: "MP" };
  const scope = { population: [person], officers: [], states: [] } as never;
  const f = { from: D, to: D, basis: "ORIGINAL" as const, type: "ALL" as const, section: "", source: "", status: "", focusDate: null, page: 1, pageSize: 100 };
  const all = JSON.parse(JSON.stringify(await ana.getTaskAnalysis(scope, f))) as { summary: { total: number; completed: number; abandoned: number; rescheduledTasks: number }; rows: { key: string; section: string; dealerId: string; amount: number | null; status: string }[] };
  eq(new Set(all.rows.map((r) => r.key)).size, all.rows.length, "no task appears twice");
  const aRecovery = all.rows.filter((r) => r.section === "RECOVERY" && r.dealerId === "A").map((r) => [r.amount, r.status]).sort();
  eq(aRecovery.map((x) => x[0]), [11111, 12444, 5000], "dealer A's three Recovery tasks are three separate tasks with their own amounts");
  eq([all.summary.abandoned, all.summary.rescheduledTasks], [1, 2], "one abandonment; two rescheduled tasks (the Recovery task and the continued Sales manual task), each counted once");
  const act = await ana.getTaskActivity(scope, D, D);
  eq(act.get(`so1|${D}`)?.tasks, all.summary.total, "Task Activity agrees with the Tasks list");
  eq(act.get(`so1|${D}`)?.completed, all.summary.completed);
  console.log("task-rows.integration.ts — all scenarios passed");

}
main().then(async () => { await prisma.$disconnect(); }, async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
