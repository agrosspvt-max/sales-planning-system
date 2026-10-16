/**
 * Performance → Task Activity / Tasks coverage against a REAL, disposable PostgreSQL database: every genuine piece of planned work (Sales, Recovery, Dealer Appointment, Visits per
 * category, Scheme Conversion when enabled, explicit Others tasks) is ONE task with one completion rule, counted once however it reached Daily Work.
 *
 *   BILLING_TASK_TEST_URL=postgresql://localhost:5432/billing_task_test npm run test:task-coverage:db
 */
import assert from "node:assert/strict";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import * as realDailyWork from "@/lib/daily-work";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";

const url = process.env.BILLING_TASK_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/billing_task_test")
  throw new Error("Only a local database named billing_task_test is permitted (set BILLING_TASK_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => tx.auditLog.create({ data }) },
  "@/lib/daily-work": { ...realDailyWork, currentBusinessDate: (d?: Date) => (d ? realDailyWork.currentBusinessDate(d) : "2026-10-20") },
});
const ana = load<typeof import("@/features/tasks/task-analysis.server")>("src/features/tasks/task-analysis.server.ts");
const eq = (actual: unknown, expected: unknown, message?: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
interface Row { key: string; sourceType: string; taskId: string; section: string; status: string; dealerName: string | null; category: string | null; target: number | null }
interface Analysis { summary: { total: number; completed: number }; rows: Row[] }
const plain = (v: unknown): never => JSON.parse(JSON.stringify(v)) as never;
const rowsOf = async (scope: never, f: ReturnType<typeof base>) => (plain(await ana.getTaskAnalysis(scope, f)) as Analysis).rows;
const person = (id: string) => ({ id, name: id.toUpperCase(), role: "SALES_OFFICER", groupId: "g1", groupName: "MP" });
const scopeOf = (...ids: string[]) => ({ population: ids.map(person), officers: [], states: [] }) as never;
const date = (d: string) => new Date(`${d}T00:00:00Z`);
const D = "2026-09-10", D2 = "2026-09-11", D3 = "2026-09-12";
const base = (d: string) => ({ from: d, to: d, basis: "ORIGINAL" as const, type: "ALL" as const, section: "", source: "", status: "", focusDate: null, page: 1, pageSize: 100 });
let seq = 0;
const row = (officerId: string, workDate: string, section: string, data: Record<string, unknown> = {}) =>
  prisma.dailyWorkEntry.create({ data: { id: `e${++seq}`, officerId, workDate: date(workDate), batchId: `b-${officerId}-${workDate}`, section, rowKey: (data.rowKey as string) ?? `k${seq}`, status: "FINALIZED", planSubmittedAt: new Date(), ...data } as never });
const finalizeDay = (officerId: string, workDate: string) => prisma.dailyWorkDay.create({ data: { officerId, workDate: date(workDate), currentBatchId: `b-${officerId}-${workDate}`, status: "FINALIZED", finalizedAt: new Date() } });

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "CalendarEntry","BillingExceptionTask","BillingException","DailyTaskOutcome","DailyWorkEntry","DailyWorkDay","DealerAssignment","Dealer","AuditLog","Notification","TaskRescheduleEvent","User","UserGroup" CASCADE`);
  await prisma.userGroup.create({ data: { id: "g1", name: "MP" } });
  for (const id of ["so1", "so2", "so3"]) await prisma.user.create({ data: { id, name: id.toUpperCase(), username: id, passwordHash: "x", role: Role.SALES_OFFICER, groupId: "g1" } as never });
  for (const id of ["A", "B", "C"]) await prisma.dealer.create({ data: { id, name: `Dealer ${id}` } });

  /* ---- the worked example: a finalized report with Sales ×3, Recovery ×2, Appointment ×2, two visit categories ---- */
  await row("so1", D, "SALES", { dealerId: "A", todaysPlan: 1000, todaysActual: 1000 }); // met
  await row("so1", D, "SALES", { dealerId: "B", todaysPlan: 2000, todaysActual: 500 }); // short of target
  await row("so1", D, "SALES", { dealerId: "C", todaysPlan: 3000, todaysActual: 0 }); // zero actual
  await row("so1", D, "RECOVERY", { dealerId: "A", todaysPlan: 500, todaysActual: 700 }); // exceeded
  await row("so1", D, "RECOVERY", { dealerId: "B", todaysPlan: 800, todaysActual: 0 });
  await row("so1", D, "APPOINTMENT", { typedDealerName: "Ram Traders", marketName: "Raigarh", resultStatus: "APPOINTED" });
  await row("so1", D, "APPOINTMENT", { typedDealerName: "Shyam Stores", marketName: "Korba", resultStatus: "NOT_APPOINTED" }); // recorded, not a success
  await row("so1", D, "APPOINTMENT", { typedDealerName: "", marketName: null }); // a blank placeholder: nothing
  await row("so1", D, "SALES", { dealerId: "A", rowKey: "draft-sales", todaysPlan: 999, status: "DRAFT", planSubmittedAt: null }); // an unsubmitted draft: nothing
  await row("so1", D, "SALES", { dealerId: "B", rowKey: "zero-plan", todaysPlan: 0, todaysActual: 0 }); // no planned amount: nothing
  await row("so1", D, "SCHEME_CONVERSION", { dealerId: "A", todaysPlan: 10, resultStatus: "YES" }); // the feature is switched off: not counted
  await row("so1", D, "SUMMARY", { rowKey: "SUMMARY", dealerVisits: 4, actualDealerVisits: 4, newPartyVisits: 2, actualNewPartyVisits: 1, others: "Met the stockist; collected feedback" }); // an ordinary note is not a task
  await finalizeDay("so1", D);
  // No Plan section + notes only
  await row("so2", D, "SUMMARY", { rowKey: "SUMMARY", noPlanSections: "SALES,RECOVERY,APPOINTMENT,VISITS,OTHERS" });
  await finalizeDay("so2", D);
  await prisma.calendarEntry.create({ data: { ownerId: "so2", date: date(D), kind: "REMINDER", text: "Call the bank" } as never }); // reminders are never tasks

  const scope1 = scopeOf("so1");
  const a1 = plain(await ana.getTaskAnalysis(scope1, base(D))) as Analysis;
  eq([a1.summary.total, a1.summary.completed], [9, 4], "3 Sales + 2 Recovery + 2 Appointment + 2 Visits categories = 9 tasks, 4 completed");
  const bySection = (rows: Row[]) => rows.reduce<Record<string, [number, number]>>((m, r) => { const c = m[r.section] ?? [0, 0]; c[0]++; if (r.status === "COMPLETED") c[1]++; m[r.section] = c; return Object.fromEntries(Object.entries(m).sort(([x], [y]) => x.localeCompare(y))); }, {});
  eq(bySection(a1.rows), { APPOINTMENT: [2, 1], RECOVERY: [2, 1], SALES: [3, 1], VISITS: [2, 1] }, "per-section totals");
  const visits = a1.rows.filter((r) => r.section === "VISITS");
  eq(visits.map((r) => [r.category, r.target, r.status]).sort(), [["DEALER_VISITS", 4, "COMPLETED"], ["NEW_PARTY_VISITS", 2, "OVERDUE"]], "one task per category with its target; success in one never covers the other");
  assert.ok(!a1.rows.some((r) => r.section === "OTHERS" || r.section === "SCHEME_CONVERSION"), "notes and the disabled Scheme Conversion contribute no task");
  const notAppointed = a1.rows.find((r) => r.dealerName === "Shyam Stores");
  assert.notEqual(notAppointed!.status, "COMPLETED", "Not Appointed is recorded but never a completion");

  // Task Activity agrees with the Tasks population, cell by cell; and the click-through filters give the same numbers.
  const act = await ana.getTaskActivity(scopeOf("so1", "so2"), D, D);
  eq([act.get(`so1|${D}`)?.tasks, act.get(`so1|${D}`)?.completed, Object.entries(act.get(`so1|${D}`)?.sections ?? {}).sort()], [9, 4, [["APPOINTMENT", 2], ["RECOVERY", 2], ["SALES", 3], ["VISITS", 2]]], "Task Activity cell");
  eq(act.get(`so2|${D}`), undefined, "a No Plan day with only a reminder has no tasks (no cell at all)");
  eq((await rowsOf(scope1, { ...base(D), status: "COMPLETED" })).length, 4, "the Completed filter opens exactly the completed tasks");
  eq((await rowsOf(scope1, { ...base(D), section: "VISITS" })).length, 2, "the section filter agrees with the breakdown");
  eq((plain(await ana.getTaskAnalysis(scopeOf("so2"), base(D))) as Analysis).summary.total, 0, "nothing for the other employee");
  // history of a visit task is readable, stable and scoped
  const vid = visits[0]!.taskId;
  const hist = plain(await ana.getTaskHistory(scope1, "DAILY_WORK_VISIT", vid)) as { task: { section: string }; events: unknown[] };
  eq([hist.task.section, hist.events.length], ["VISITS", 0], "a visit task has a stable identity and an (empty) history");
  await assert.rejects(ana.getTaskHistory(scopeOf("so2"), "DAILY_WORK_VISIT", vid), "another employee's scope cannot open it");

  /* ---- Calendar tasks that materialized into Daily Work are counted ONCE ---- */
  // visits: 2 dealer visits came from a Calendar task, 1 more was planned by hand
  const sum2 = await row("so3", D2, "SUMMARY", { rowKey: "SUMMARY", dealerVisits: 3, actualDealerVisits: 3, others: "Calendar note" });
  await prisma.calendarEntry.create({ data: { ownerId: "so3", date: date(D2), kind: "TASK", taskSection: "VISITS", dealerVisits: 2, dailyWorkEntryId: sum2.id, materializedAt: new Date() } as never });
  // an explicit Others task (and the note it wrote into the row) is one task; a reminder is none
  await prisma.calendarEntry.create({ data: { ownerId: "so3", date: date(D2), kind: "TASK", taskSection: "OTHERS", text: "Visit the bank", dailyWorkEntryId: sum2.id, materializedAt: new Date() } as never });
  await prisma.calendarEntry.create({ data: { ownerId: "so3", date: date(D2), kind: "REMINDER", text: "Birthday" } as never });
  // appointment: the Daily Work row IS the Calendar task
  const ap = await row("so3", D2, "APPOINTMENT", { rowKey: "cal-x1", typedDealerName: "Mohan Agro", marketName: "Bilaspur", resultStatus: "APPOINTED" });
  await prisma.calendarEntry.create({ data: { ownerId: "so3", date: date(D2), kind: "TASK", taskSection: "APPOINTMENT", typedDealerName: "Mohan Agro", marketName: "Bilaspur", dailyWorkEntryId: ap.id, materializedAt: new Date() } as never });
  // sales: 600 came from a Calendar task, 400 was planned by hand on the same dealer row
  const sl = await row("so3", D2, "SALES", { dealerId: "A", todaysPlan: 1000, todaysActual: 1000 });
  await prisma.calendarEntry.create({ data: { ownerId: "so3", date: date(D2), kind: "TASK", taskSection: "SALES", dealerId: "A", amount: 600, dailyWorkEntryId: sl.id, dailyWorkContribution: 600, materializedAt: new Date() } as never });
  await finalizeDay("so3", D2);
  const a2 = plain(await ana.getTaskAnalysis(scopeOf("so3"), base(D2))) as Analysis;
  eq(bySection(a2.rows), { APPOINTMENT: [1, 1], OTHERS: [1, 1], SALES: [2, 2], VISITS: [2, 2] }, "calendar + manual remainder, each exactly once");
  eq(a2.rows.map((r) => r.key).length, new Set(a2.rows.map((r) => r.key)).size, "no task appears twice");
  eq(a2.rows.filter((r) => r.section === "VISITS").map((r) => [r.sourceType, r.target]).sort(), [["CALENDAR_ENTRY", null], ["DAILY_WORK_VISIT", 1]], "the Calendar visit task + only the 1 manual visit left as a target");
  eq((await ana.getTaskActivity(scopeOf("so3"), D2, D2)).get(`so3|${D2}`)?.tasks, 6, "Task Activity agrees (6 distinct tasks)");

  /* ---- a Calendar visit task needs EACH of its categories met; a shortfall in one is not covered by the other ---- */
  const sum3 = await row("so3", D3, "SUMMARY", { rowKey: "SUMMARY", dealerVisits: 2, actualDealerVisits: 5, newPartyVisits: 2, actualNewPartyVisits: 1 });
  await prisma.calendarEntry.create({ data: { ownerId: "so3", date: date(D3), kind: "TASK", taskSection: "VISITS", dealerVisits: 2, newPartyVisits: 2, dailyWorkEntryId: sum3.id, materializedAt: new Date() } as never });
  await finalizeDay("so3", D3);
  const a3 = plain(await ana.getTaskAnalysis(scopeOf("so3"), base(D3))) as Analysis;
  eq(a3.rows.map((r) => [r.sourceType, r.status]), [["CALENDAR_ENTRY", "OVERDUE"]], "5 dealer visits do not make up for 1 of 2 new-party visits; the whole row came from the Calendar task");

  /* ---- an unfinalized report never completes anything ---- */
  await row("so1", "2026-09-13", "SALES", { dealerId: "A", todaysPlan: 100, todaysActual: 100, status: "PLAN_SUBMITTED" });
  const open = (plain(await ana.getTaskAnalysis(scope1, base("2026-09-13"))) as Analysis).summary;
  eq([open.total, open.completed], [1, 0], "no finalized report → not completed");
  /* ---- Daily Report outcomes: a Completed outcome counts as completion only when its Actual reached the task's planned target ---- */
  const D5 = "2026-09-14";
  for (const [dealerId, plan, actual] of [["A", 100, 100], ["B", 200, 150]] as const) {
    const e = await row("so1", D5, "SALES", { dealerId, todaysPlan: plan, todaysActual: actual });
    await prisma.dailyTaskOutcome.create({ data: { entryId: e.id, unitType: "MANUAL_ROW", unitId: e.id, officerId: "so1", workDate: date(D5), section: "SALES", plannedAmount: plan, outcome: "COMPLETED", actualAmount: actual, state: "COMMITTED", committedAt: new Date(), committedById: "so1", committedByName: "SO1" } as never });
  }
  await finalizeDay("so1", D5);
  eq((await rowsOf(scope1, base(D5))).map((r) => [r.dealerName, r.status]).sort(), [["Dealer A", "COMPLETED"], ["Dealer B", "OVERDUE"]], "Actual 150 of 200 is a recorded result, not a completion");
  console.log("task-coverage.integration.ts — all scenarios passed");
}
main().then(async () => { await prisma.$disconnect(); }, async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
