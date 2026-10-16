/**
 * Billing Exception → Daily Work → Recovery against a REAL, disposable PostgreSQL database (row locks, unique identities, atomic rollback).
 *
 *   createdb billing_task_test && DATABASE_URL=postgresql://localhost:5432/billing_task_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   BILLING_TASK_TEST_URL=postgresql://localhost:5432/billing_task_test npm run test:billing-tasks:db
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
const dw = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => ({}) },
  "@/lib/daily-work": { ...realDailyWork, currentBusinessDate: (d?: Date) => (d ? realDailyWork.currentBusinessDate(d) : clock) },
  "@/lib/scope": { getCurrentDealerIds: async (id: string) => (await prisma.dealerAssignment.findMany({ where: { officerId: id } })).map((a) => a.dealerId), getOfficerScope: async (c: AuthContext) => ({ all: false, ids: [c.userId] }), assertOfficerInScope: async () => undefined },
  "@/features/labels/service.server": { getResolvedLabels: async () => DEFAULT_LABELS },
  "@/features/schemes/scheme-planning.server": { runningSchemes: async () => [] },
  "@/features/planning/monthly.server": { getMonthly: async () => ({ monthlyMode: "PACK_SIZE", months: [], dealers: [] }) },
  "@/features/planning/monthly-plan.server": { resolveAddableSeasonalPlanId: async () => null },
  "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => 0, latestCnRequestStatusByDealer: async () => new Map() },
  "@/lib/recovery-config": { getAutoTasksEnabled: async () => false, getCalendarEnabled: async () => true },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map(), resolveDealerDisplayNames: async () => new Map(), decorateDealerNames: async (r: unknown[]) => r, dealerDisplayName: (n: string) => n },
  "./auto-task-materialization.server": { materializeDueDailyWorkTasks: async () => ({}), materializeDueDailyWorkTasksInTransaction: async () => ({}), autoTasksApplyToRole: () => true },
  "./calendar-task-materialization.server": { materializeDueCalendarTasks: async () => ({}), calendarLinkedEntryIds: async () => [] },
});
const svc = dw<typeof import("./service.server")>("src/features/daily-work/service.server.ts");
const be = load<typeof import("@/features/reports/billing-exception.server")>("src/features/reports/billing-exception.server.ts");
const task = load<typeof import("./billing-task.server")>("src/features/daily-work/billing-task.server.ts");
const auto = load<typeof import("./auto-task-materialization.server")>("src/features/daily-work/auto-task-materialization.server.ts");
const cal = load<typeof import("@/features/calendar/calendar.server")>("src/features/calendar/calendar.server.ts");
const lock = load<typeof import("./day-lock.server")>("src/features/daily-work/day-lock.server.ts");

const eq = (actual: unknown, expected: unknown, message?: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const ctx = (userId: string, role: Role, groupId: string | null = "g1", permissions?: Record<string, string[]>): AuthContext => ({ userId, username: userId, role, groupId, permissions }) as AuthContext;
const admin = ctx("admin", Role.SUPER_ADMIN, null), so1 = ctx("so1", Role.SALES_OFFICER), so2 = ctx("so2", Role.SALES_OFFICER), rm = ctx("rm", Role.REGIONAL_MANAGER);
const day = (n: number) => new Date(Date.parse(`${BASE}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
let seq = 0;
const input = (dealerId: string, over: Record<string, unknown> = {}) => ({ dealerId, billingDate: day(-1), billNo: `B-${++seq}`, authPerson: "Varun sir", requestId: `req-${seq}-${Math.random().toString(36).slice(2, 9)}`, billingAmount: 20000, paymentCondition: "NO", ...over, ...(over.paymentCondition === "YES" ? { paymentAmount: over.paymentAmount ?? over.billingAmount ?? 20000 } : {}) }); // Yes needs an explicit Payment; most scenarios use Payment = Amount, the dedicated one below differs
const batch = (officer: string, date: string) => `draft:${officer}:${date}`;
/** Materialize for an officer on a date, through the real day lock — what Daily Work reads and submit gates run. */
const materialize = (officer: string, date: string) => prisma.$transaction(async (tx) => { const d = await lock.lockDailyWorkDay(tx, officer, date); return auto.materializeDueDailyWorkTasksInTransaction(tx, officer, date, d); }, { timeout: 30_000 });
const entry = async (officer: string, date: string, dealerId: string) => (await prisma.$queryRaw<{ id: string; todaysPlan: string | null; status: string; noPlanSections: string | null }[]>`SELECT "id","todaysPlan"::text AS "todaysPlan","status","noPlanSections" FROM "DailyWorkEntry" WHERE "officerId"=${officer} AND "workDate"=${date}::date AND "section"='RECOVERY' AND "rowKey"=${dealerId}`)[0];
const manual = (officer: string, date: string, dealerId: string, plan: number) => prisma.$executeRaw`INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","todaysPlan","entryType","status","createdAt","updatedAt") VALUES (${`m-${officer}-${date}-${dealerId}`},${officer},${dealerId},${dealerId},${date}::date,${batch(officer, date)},'RECOVERY',${plan},'REGULAR','DRAFT',NOW(),NOW())`;

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "BillingExceptionTask","BillingException","DealerPaymentReceipt","DealerLastPayment","DailyWorkEntry","DailyWorkDay","DealerAssignment","Dealer","AuditLog","Notification","TaskRescheduleEvent","User","UserGroup" CASCADE`);
  await prisma.userGroup.create({ data: { id: "g1", name: "MP" } });
  for (const [id, role] of [["admin", Role.SUPER_ADMIN], ["so1", Role.SALES_OFFICER], ["so2", Role.SALES_OFFICER], ["rm", Role.REGIONAL_MANAGER]] as const) await prisma.user.create({ data: { id, name: id.toUpperCase(), username: id, passwordHash: "x", role, groupId: id === "admin" ? null : "g1" } });
  const dealers: Record<string, string> = { A: "Alpha Traders", B: "Beta Stores", C: "Gamma Agro", D: "Delta NoOwner" };
  for (const [id, name] of Object.entries(dealers)) {
    await prisma.dealer.create({ data: { id, name } });
    if (id !== "D") await prisma.dealerAssignment.create({ data: { dealerId: id, officerId: "so1", effectiveFrom: new Date("2024-01-01") } });
    await acceptReceipts(prisma, [{ dealerId: id, date: day(-60), amount: 4000 + id.charCodeAt(0), sourceOrder: 1 }], { sourceKind: "REGULAR" }, clock); // Days 60 → Blocked
  }
  const receiptsBefore = await prisma.dealerPaymentReceipt.count();

  /* ---- create: Yes / No / no assignment ---- */
  const no = await be.createBillingException(admin, input("A", { paymentCondition: "NO", billingAmount: 1250.5 }));
  eq([no.billingAmount, no.paymentCondition, no.paymentDate, no.task], [1250.5, "NO", null, null]);
  /* ---- alerts (real Notification rows): No creates the exception alert for the owning SO, that SO's RM and the admin — and nobody else ---- */
  const alertsOf = (entityId: string) => prisma.notification.findMany({ where: { relatedEntityType: "BillingException", relatedEntityId: entityId }, orderBy: { userId: "asc" } });
  eq((await alertsOf(no.id)).map((n) => n.userId), ["admin", "rm", "so1"], "No → SO + RM + admin, no task needed");
  assert.ok((await alertsOf(no.id)).every((n) => !n.isRead && n.type === "SYSTEM" && n.title === "New Billing Exception" && n.message.includes("Alpha Traders") && n.message.includes("Payment condition: No")), "unread, titled, complete");
  assert.equal(await prisma.notification.count({ where: { userId: "so2" } }), 0, "an unrelated SO hears nothing");
  assert.equal(await prisma.billingExceptionTask.count(), 0, "No → no task");
  assert.equal(await code(be.createBillingException(admin, input("D", { paymentCondition: "YES", paymentDate: day(0), billingAmount: 100 }))), 422, "no assignment → clear error");
  assert.equal(await prisma.billingException.count({ where: { dealerId: "D" } }), 0, "…and no partial exception");
  for (const bad of [{ billingAmount: undefined }, { paymentCondition: "YES" }, { paymentCondition: "YES", paymentDate: day(-1) }]) assert.equal(await code(be.createBillingException(admin, input("B", bad))), 422);
  assert.equal(await code(be.createBillingException(so1, input("B", { paymentCondition: "YES", paymentDate: day(0) }))), 403, "SO cannot create");
  const cond = input("B", { paymentCondition: "YES", paymentDate: day(2), billingAmount: 20000, officerId: "so2" });
  const yes = await be.createBillingException(admin, cond);
  const t0 = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { billingExceptionId: yes.id } });
  eq([t0.officerId, t0.dealerId, Number(t0.amount), t0.promisedDate.toISOString().slice(0, 10)], ["so1", "B", 20000, day(2)], "task for the AUTHORITATIVE officer (the forged officerId was ignored)");
  const parallel = await Promise.all(Array.from({ length: 5 }, () => code(be.createBillingException(admin, cond))));
  eq(parallel, [0, 0, 0, 0, 0]);
  assert.equal(await prisma.billingExceptionTask.count({ where: { billingExceptionId: yes.id } }), 1, "five deliveries of one Save → one exception, ONE task");
  assert.equal(await prisma.billingExceptionTask.count(), 1);
  const yesAlerts = await alertsOf(yes.id);
  eq(yesAlerts.map((n) => n.userId), ["admin", "rm", "so1"], "Yes → one combined alert per recipient; five parallel deliveries of the SAME save add none");
  assert.ok(yesAlerts.every((n) => n.title === "New Billing Exception · Recovery task assigned" && n.message.includes("Billing Amount ₹20,000") && n.message.includes("Promised payment") && n.message.includes("SO1")));
  assert.equal(await prisma.notification.count({ where: { relatedEntityId: { in: [yes.id, no.id] } } }), 6);
  assert.equal(await prisma.notification.count({ where: { relatedEntityType: "BillingException", message: { contains: "Delta NoOwner" } } }), 0, "the failed save (no assignment) left no alert");
  assert.equal(await code(be.createBillingException(admin, { ...cond, billingAmount: 20001 })), 409, "same request id, different amount → refused");
  await assert.rejects(prisma.billingExceptionTask.create({ data: { billingExceptionId: yes.id, dealerId: "B", officerId: "so1", amount: 1, promisedDate: new Date(day(2)), taskDate: new Date(day(2)) } }), "the database allows at most one task per exception");
  await assert.rejects(prisma.$executeRaw`UPDATE "BillingException" SET "paymentCondition" = true, "paymentDate" = NULL WHERE "id" = ${yes.id}`, "the shape rule is a database constraint too");

  /* ---- materialization: not before its day; then exactly once, next to a manual plan and another source's contribution ---- */
  const alertCount = await prisma.notification.count();
  eq(await materialize("so1", day(1)), { materializedTasks: 0, affectedDealers: 0, finalized: false }, "a task is not due before its date");
  await manual("so1", day(2), "B", 5000);
  await prisma.$executeRaw`UPDATE "DailyWorkEntry" SET "todaysPlan" = "todaysPlan" + 3000 WHERE "id" = ${`m-so1-${day(2)}-B`}`; // stand-in for a CN / Calendar contribution already on the row
  const first = await materialize("so1", day(2));
  assert.equal(first.materializedTasks, 1);
  assert.equal(Number((await entry("so1", day(2), "B"))!.todaysPlan), 28000, "manual 5,000 + other source 3,000 + Billing Exception 20,000");
  for (let i = 0; i < 3; i++) await materialize("so1", day(2));
  assert.equal(await prisma.notification.count(), alertCount, "materializing a task into Daily Work (any number of times) never alerts");
  await Promise.all([materialize("so1", day(2)), materialize("so1", day(2)), materialize("so1", day(2))]);
  assert.equal(Number((await entry("so1", day(2), "B"))!.todaysPlan), 28000, "repeated / concurrent materialization never adds the amount again");
  const linked = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: t0.id } });
  eq([linked.dailyWorkEntryId, Number(linked.dailyWorkContribution), linked.dailyWorkConfirmed], [`m-so1-${day(2)}-B`, 20000, false]);
  assert.equal(await prisma.dealerPaymentReceipt.count(), receiptsBefore, "a condition / task fabricates no receipt");
  assert.equal(await prisma.dealerLastPayment.count({ where: { dealerId: "B", paymentDate: new Date(day(2)) } }), 0, "…and no Last Payment");
  const actualRow = await prisma.$queryRaw<{ a: string | null; m: string | null }[]>`SELECT "todaysActual"::text a, "paymentMode" m FROM "DailyWorkEntry" WHERE "id" = ${linked.dailyWorkEntryId}`;
  eq([actualRow[0]!.a, actualRow[0]!.m], [null, null], "Today's Actual and Payment Mode stay empty — a plan is not a payment");
  eq(await materialize("so2", day(2)), { materializedTasks: 0, affectedDealers: 0, finalized: false }, "another officer never receives it");

  /* ---- owner protection / details (no confirmation step exists any more) ---- */
  clock = day(2);
  assert.equal(await code(task.rescheduleBillingTask(admin, t0.id, day(6))), 403, "an administrator cannot reschedule");
  const detail = await task.getBillingTaskDetail(so1, t0.id);
  eq([detail.billNo, detail.authPerson, detail.amount, detail.officerName, detail.taskType, detail.planType], [cond.billNo, "Varun sir", 20000, "SO1", "BILLING_EXCEPTION", "RECOVERY"]);
  assert.equal(await code(task.getBillingTaskDetail(so2, t0.id)), 404, "other officers cannot see it");
  assert.equal((await task.getBillingTaskDetail(admin, t0.id)).taskId, t0.id, "an administrative viewer may read the originating exception");
  assert.equal(await code(task.getBillingTaskDetail(ctx("ca", Role.CUSTOM_ADMIN, null, { reports: ["read"] }), t0.id)), 404, "…but not without Last Payment Report access");
  const tasksIn = await task.billingTasksForEntries("so1", [linked.dailyWorkEntryId!], day(2));
  eq(tasksIn.map((t) => [t.dealerName, t.amount, t.taskType, t.planType, t.promisedDate, t.confirmed]), [["Beta Stores", 20000, "BILLING_EXCEPTION", "RECOVERY", day(2), false]]);
  eq(await task.billingLinkedEntryIds([linked.dailyWorkEntryId!, "other"]), [linked.dailyWorkEntryId], "row label source");

  /* ---- reschedule: only this task's contribution moves; promised date is kept; past dates refused ---- */
  assert.equal(await code(task.rescheduleBillingTask(so1, t0.id, day(-1))), 422, "a past day would rewrite submitted work");
  assert.equal(await code(task.rescheduleBillingTask(so1, t0.id, day(2))), 422, "today itself is refused: the new date must be AFTER the current business date");
  assert.equal(await code(task.rescheduleBillingTask(so1, t0.id, "2026-02-31")), 422, "an impossible date is refused");
  assert.equal(await code(task.rescheduleBillingTask(so2, t0.id, day(5))), 403);
  assert.equal(Number((await entry("so1", day(2), "B"))!.todaysPlan), 28000, "refused requests changed nothing");
  await task.rescheduleBillingTask(so1, t0.id, day(5));
  await task.rescheduleBillingTask(so1, t0.id, day(5)); // a retry of the same request is a no-op
  assert.equal(Number((await entry("so1", day(2), "B"))!.todaysPlan), 8000, "only the 20,000 left; manual + other source stay");
  const moved = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: t0.id } });
  eq([moved.dailyWorkEntryId, moved.dailyWorkConfirmed, moved.rescheduled, moved.taskDate.toISOString().slice(0, 10), moved.promisedDate.toISOString().slice(0, 10)], [null, false, true, day(5), day(2)]);
  // The responsible Regional Manager may move it too (another team's RM may not); the same task row keeps moving, nothing is created.
  assert.equal(await code(task.rescheduleBillingTask(ctx("rmX", Role.REGIONAL_MANAGER, "g9"), t0.id, day(6))), 403, "an RM outside the team is refused");
  await task.rescheduleBillingTask(rm, t0.id, day(6)); await task.rescheduleBillingTask(rm, t0.id, day(5)); await task.rescheduleBillingTask(rm, t0.id, day(5));
  assert.equal(await prisma.billingExceptionTask.count({ where: { billingExceptionId: yes.id } }), 1, "still ONE task row");
  clock = day(5); await materialize("so1", day(5));
  assert.equal(Number((await entry("so1", day(5), "B"))!.todaysPlan), 20000, "re-applied once on the new day, in a new row");
  assert.equal((await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: t0.id } })).id, t0.id, "same task id");

  /* ---- overdue: a missed day keeps the task; it shows up on the next editable day with its original promised date ---- */
  const late = await be.createBillingException(admin, input("C", { paymentCondition: "YES", paymentDate: day(6), billingAmount: 9000 }));
  const lt = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { billingExceptionId: late.id } });
  clock = day(8); // the officer never opened Daily Work on day 6 / 7
  await materialize("so1", day(8));
  const overdue = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: lt.id } });
  eq([!!overdue.dailyWorkEntryId, overdue.promisedDate.toISOString().slice(0, 10)], [true, day(6)], "overdue task enters the next editable day; its promised date is untouched");
  assert.equal((await task.billingTasksForEntries("so1", [overdue.dailyWorkEntryId!], day(8)))[0]!.overdue, true);

  /* ---- finalized day is never touched; the task waits for the next editable day ---- */
  clock = day(10);
  const fin = await be.createBillingException(admin, input("A", { paymentCondition: "YES", paymentDate: day(10), billingAmount: 4000, billingDate: day(9) }));
  const ft = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { billingExceptionId: fin.id } });
  await prisma.$transaction((tx) => lock.lockDailyWorkDay(tx, "so1", day(10)));
  await prisma.$executeRaw`UPDATE "DailyWorkDay" SET "status" = 'FINALIZED' WHERE "officerId" = 'so1' AND "workDate" = ${day(10)}::date`;
  eq((await materialize("so1", day(10))).finalized, true);
  assert.equal((await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: ft.id } })).dailyWorkEntryId, null, "the finalized day was not modified");
  assert.equal(await entry("so1", day(10), "A"), undefined);
  clock = day(11); await materialize("so1", day(11));
  assert.ok((await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: ft.id } })).dailyWorkEntryId, "…it is carried to the next editable day");

  /* ---- submitted work is immutable ---- */
  const submittedEntry = (await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: ft.id } })).dailyWorkEntryId!;
  await prisma.$executeRaw`UPDATE "DailyWorkEntry" SET "status" = 'PLAN_SUBMITTED', "batchId" = 'frozen-batch' WHERE "id" = ${submittedEntry}`;
  assert.equal(await code(task.rescheduleBillingTask(so1, ft.id, day(15))), 409, "a task inside submitted Daily Work cannot be rescheduled");
  await materialize("so1", day(12));
  assert.equal((await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: ft.id } })).dailyWorkEntryId, submittedEntry, "…and is never re-materialized or moved");

  /* ---- ownership change before it enters Daily Work ---- */
  clock = day(12);
  const moveEx = await be.createBillingException(admin, input("B", { paymentCondition: "YES", paymentDate: day(13), billingAmount: 3000, billingDate: day(11) }));
  const mt = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { billingExceptionId: moveEx.id } });
  await prisma.dealerAssignment.updateMany({ where: { dealerId: "B", effectiveTo: null }, data: { effectiveTo: new Date(`${day(12)}T00:00:00Z`) } });
  await prisma.dealerAssignment.create({ data: { dealerId: "B", officerId: "so2", effectiveFrom: new Date(`${day(12)}T00:00:00Z`) } });
  clock = day(13);
  eq((await materialize("so1", day(13))).materializedTasks, 0, "the previous owner no longer receives it");
  eq((await materialize("so2", day(13))).materializedTasks, 1, "the dealer's CURRENT officer does");
  const rerouted = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: mt.id } });
  eq([rerouted.officerId, Number((await entry("so2", day(13), "B"))!.todaysPlan)], ["so2", 3000]);
  assert.ok((await prisma.auditLog.count({ where: { entity: "billingExceptionTask", entityId: mt.id, summary: { contains: "re-routed" } } })) === 1, "the re-routing is audited");
  // already-submitted work keeps its owner: the earlier task (so1's frozen entry) is untouched by the reassignment
  assert.equal((await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: ft.id } })).officerId, "so1");

  /* ---- a stale second open assignment never captures another officer's task ---- */
  await prisma.dealer.create({ data: { id: "E", name: "Echo Two Owners" } });
  await prisma.dealerAssignment.create({ data: { dealerId: "E", officerId: "so1", effectiveFrom: new Date("2024-01-01") } }); // older, never closed
  await prisma.dealerAssignment.create({ data: { dealerId: "E", officerId: "so2", effectiveFrom: new Date("2025-01-01") } }); // the CURRENT owner (most recent open assignment)
  await acceptReceipts(prisma, [{ dealerId: "E", date: day(-60), amount: 10, sourceOrder: 1 }], { sourceKind: "REGULAR" }, clock);
  const twoOwners = await be.createBillingException(admin, input("E", { paymentCondition: "YES", paymentDate: day(13), billingAmount: 800, billingDate: day(12) }));
  assert.equal((await prisma.billingExceptionTask.findUniqueOrThrow({ where: { billingExceptionId: twoOwners.id } })).officerId, "so2", "the most recent open assignment is the owner");
  eq((await materialize("so1", day(13))).materializedTasks, 0, "the stale assignment cannot capture it");
  eq((await materialize("so2", day(13))).materializedTasks, 1);

  /* ---- lifecycle is independent of the exception's billing status ---- */
  await acceptReceipts(prisma, [{ dealerId: "B", date: day(12), amount: 1, sourceOrder: 1 }], { sourceKind: "REGULAR" }, clock); // the dealer becomes Open
  await be.reconcileBillingExceptions({ today: clock, actor: { userId: "admin" } });
  assert.equal((await prisma.billingException.findUniqueOrThrow({ where: { id: moveEx.id } })).status, "RESOLVED");
  assert.ok((await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: mt.id } })).dailyWorkEntryId, "resolving the exception neither deletes nor completes its task");

  /* ---- Payment (promised recovery amount) is separate from the billing Amount: the task, Today's Plan and the Calendar use the PAYMENT ---- */
  await prisma.dealer.create({ data: { id: "P", name: "Payment Separate" } });
  await prisma.dealerAssignment.create({ data: { dealerId: "P", officerId: "so1", effectiveFrom: new Date("2024-01-01") } });
  await acceptReceipts(prisma, [{ dealerId: "P", date: day(-60), amount: 10, sourceOrder: 1 }], { sourceKind: "REGULAR" }, clock);
  clock = day(13);
  const sep = await be.createBillingException(admin, input("P", { billingAmount: 50000, paymentAmount: 15000, paymentCondition: "YES", paymentDate: day(30) }));
  const sepRow = await prisma.billingException.findUniqueOrThrow({ where: { id: sep.id }, include: { task: true } });
  eq([Number(sepRow.billingAmount), Number(sepRow.paymentAmount), Number(sepRow.task!.amount)], [50000, 15000, 15000], "Amount 50,000 and Payment 15,000 are two stored values; the task is planned for 15,000");
  assert.equal(await code(be.createBillingException(admin, { ...input("P", { paymentCondition: "YES", paymentDate: day(30) }), paymentAmount: undefined })), 422, "Payment is required");
  const sepMonth = { year: Number(day(30).slice(0, 4)), month: Number(day(30).slice(5, 7)) };
  /* ---- Calendar Daily Task (a separate automatic-task source): a FUTURE-dated task alerts at creation; reminders and reads never do ---- */
  const beforeCal = await prisma.notification.count();
  const calTaskEntry = await cal.createCalendarEntry(so1, { kind: "TASK", date: day(40), section: "RECOVERY", dealerId: "A", amount: 7500, paymentMode: "UPI" });
  const calAlerts = await prisma.notification.findMany({ where: { relatedEntityType: "CalendarEntry", relatedEntityId: calTaskEntry.id }, orderBy: { userId: "asc" } });
  eq(calAlerts.map((n) => n.userId), ["admin", "rm", "so1"], "calendar task → the SO, the RM and the admin, on the creation day");
  assert.ok(calAlerts.every((n) => n.message.includes("Calendar → Recovery") && n.message.includes("Alpha Traders") && n.message.includes(`${day(40).slice(8)}/${day(40).slice(5, 7)}/${day(40).slice(0, 4)}`) && n.message.includes("₹7,500")));
  await cal.createCalendarEntry(so1, { kind: "REMINDER", date: day(41), text: "call" });
  await cal.calendarMonth(so1, { ...sepMonth } as never); await cal.calendarMonth(admin, { ...sepMonth } as never);
  assert.equal(await prisma.notification.count(), beforeCal + 3, "a reminder and calendar reads add no alert");
  /* ---- Admin assigns a Manual Task / Reminder to a Sales Officer: owned by the SO, created by the Admin, in the SO's Daily Work exactly once, alerts once ---- */
  const ym = (dk: string) => ({ year: Number(dk.slice(0, 4)), month: Number(dk.slice(5, 7)) });
  const calMat = load<typeof import("./calendar-task-materialization.server")>("src/features/daily-work/calendar-task-materialization.server.ts");
  const beforeAssign = await prisma.notification.count();
  const asg = await cal.createCalendarEntry(admin, { kind: "TASK", date: day(45), section: "RECOVERY", dealerId: "A", amount: 9100, paymentMode: "CASH", ownerId: "so1" });
  const asgRow = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: asg.id } });
  eq([asgRow.ownerId, asgRow.createdById, asgRow.kind, asgRow.taskSection, asgRow.entryType], ["so1", "admin", "TASK", "RECOVERY", "REGULAR"], "owner = the SO, creator = the Admin (audit), Manual Regular recovery");
  eq([(await cal.calendarMonth(so1, { ...ym(day(45)) } as never)).entries.some((e) => e.id === asg.id), (await cal.calendarMonth(so2, { ...ym(day(45)) } as never)).entries.some((e) => e.id === asg.id)], [true, false], "in the SO's Calendar only");
  eq((await prisma.notification.findMany({ where: { relatedEntityType: "CalendarEntry", relatedEntityId: asg.id }, orderBy: { userId: "asc" } })).map((n) => n.userId), ["admin", "rm", "so1"], "the concerned SO, their RM and the Admin — once each");
  const runCal = () => prisma.$transaction(async (tx) => { const d = await lock.lockDailyWorkDay(tx, "so1", day(45)); return calMat.materializeDueCalendarTasksInTransaction(tx, "so1", day(45), d); }, { timeout: 30_000 });
  const m1 = await runCal(), m2 = await runCal(), m3 = await Promise.all([runCal(), runCal()]);
  eq([m1.materialized, m2.materialized, m3.map((x) => x.materialized).sort()], [1, 0, [0, 0]], "enters the SO's Daily Work exactly once, however often it is opened");
  const asgEntry = (await entry("so1", day(45), "A"))!;
  eq([asgEntry.todaysPlan, (await prisma.calendarEntry.findUniqueOrThrow({ where: { id: asg.id } })).dailyWorkEntryId === asgEntry.id], ["9100.00", true], "one Daily Work row, plan = the amount, linked to the calendar entry");
  eq([await entry("admin", day(45), "A"), await entry("so2", day(45), "A")], [undefined, undefined], "nothing lands in the Admin's or another officer's Daily Work");
  assert.equal(await prisma.notification.count(), beforeAssign + 3, "no alert from the materialization");
  eq(await code(cal.deleteCalendarEntry(so1, asg.id)), 403, "the recipient cannot remove the assignment…");
  // reminders: personal + assigned; neither becomes Daily Work
  const rPersonal = await cal.createCalendarEntry(admin, { kind: "REMINDER", date: day(46), text: "mine" });
  const rAssigned = await cal.createCalendarEntry(admin, { kind: "REMINDER", date: day(46), text: "call the dealers", ownerId: "so1" });
  eq([rPersonal.ownerId, rAssigned.ownerId, rAssigned.task], ["admin", "so1", null]);
  eq((await prisma.notification.findMany({ where: { relatedEntityType: "CalendarEntry", relatedEntityId: rAssigned.id } })).map((n) => n.userId).sort(), ["admin", "rm", "so1"], "an assigned reminder alerts the SO, the RM and the Admin once");
  eq(await prisma.notification.count({ where: { relatedEntityId: rPersonal.id } }), 0, "a personal reminder is silent");
  eq(await prisma.calendarEntry.count({ where: { id: { in: [rPersonal.id, rAssigned.id] }, materializedAt: { not: null } } }), 0, "a reminder never becomes a task");
  eq([await code(cal.createCalendarEntry(so1, { kind: "TASK", date: day(46), section: "OTHERS", text: "x", ownerId: "so2" })), await code(cal.createCalendarEntry(rm, { kind: "REMINDER", date: day(46), text: "x", ownerId: "so1" })), await code(cal.createCalendarEntry(admin, { kind: "TASK", date: day(46), section: "SALES", dealerId: "A", amount: 5, ownerId: "so2" }))], [403, 403, 403], "SO / RM cannot assign; a dealer that is not the recipient's is refused");
  // the delete of an un-materialized assignment by its creator
  const asg2 = await cal.createCalendarEntry(admin, { kind: "TASK", date: day(47), section: "OTHERS", text: "visit the market", ownerId: "so1" });
  eq(await code(cal.deleteCalendarEntry(admin, asg2.id)), 0, "its creator may withdraw an assignment that has not entered Daily Work");
  eq(await code(cal.deleteCalendarEntry(admin, asg.id)), 409, "…but not one that is already in Daily Work");
  eq(((await cal.calendarMonth(so1, sepMonth as never)).billingTasks.find((t) => t.id === sepRow.task!.id))?.amount, 15000, "the Calendar shows the promised Payment");
  clock = day(30); await materialize("so1", day(30));
  assert.equal(Number((await entry("so1", day(30), "P"))!.todaysPlan), 15000, "Today's Plan receives exactly the Payment");
  eq(Number((await be.getBillingExceptionDetail(admin, sep.id)).billingAmount), 50000, "the exception's billing amount is untouched");
  clock = day(13);

  /* ---- Calendar: ONE task, many authorized viewers; read-only; follows reschedule / reassignment / materialization ---- */
  await prisma.userGroup.create({ data: { id: "g2", name: "UP" } });
  for (const [id, role] of [["so3", Role.SALES_OFFICER], ["rm2", Role.REGIONAL_MANAGER]] as const) await prisma.user.create({ data: { id, name: id.toUpperCase(), username: id, passwordHash: "x", role, groupId: "g2" } });
  const so3 = ctx("so3", Role.SALES_OFFICER, "g2"), rm2 = ctx("rm2", Role.REGIONAL_MANAGER, "g2");
  const caBoth = ctx("ca1", Role.CUSTOM_ADMIN, null, { calendar: ["read"], lastPaymentReport: ["read"] }), caCalOnly = ctx("ca2", Role.CUSTOM_ADMIN, null, { calendar: ["read"] });
  await prisma.dealer.create({ data: { id: "F", name: "Foxtrot Calendar" } });
  await prisma.dealerAssignment.create({ data: { dealerId: "F", officerId: "so1", effectiveFrom: new Date("2024-01-01") } });
  await acceptReceipts(prisma, [{ dealerId: "F", date: day(-60), amount: 77, sourceOrder: 1 }], { sourceKind: "REGULAR" }, clock);
  clock = day(13);
  const calEx = await be.createBillingException(admin, input("F", { paymentCondition: "YES", paymentDate: day(20), billingAmount: 7000, billingDate: day(12) }));
  const calTask = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { billingExceptionId: calEx.id } });
  const monthOf = (dk: string) => ({ year: Number(dk.slice(0, 4)), month: Number(dk.slice(5, 7)) });
  const seen = async (who: AuthContext, dk: string, extra: Record<string, unknown> = {}) => (await cal.calendarMonth(who, { ...monthOf(dk), ...extra } as never)).billingTasks.filter((t) => t.id === calTask.id);
  const dwBefore = [await prisma.dailyWorkEntry.count(), await prisma.calendarEntry.count()];
  const one = await seen(so1, day(20));
  eq([one.length, one[0]?.dateKey, one[0]?.dealerName, one[0]?.amount, one[0]?.taskType, one[0]?.ownerName, one[0]?.status, one[0]?.promisedDate, one[0]?.billingExceptionId], [1, day(20), "Foxtrot Calendar", 7000, "BILLING_EXCEPTION", "SO1", "SCHEDULED", day(20), calEx.id], "the SO sees the scheduled task before its day, with every required field");
  eq([(await seen(rm, day(20), { view: "team" })).length, (await seen(rm, day(20))).length, (await seen(rm, day(20), { view: "mine" })).length], [1, 1, 0], "the supervising RM sees THE SAME task in the Team Calendar (not their personal one)");
  eq((await seen(rm, day(20), { view: "team" }))[0]!.id, calTask.id, "one task id for every viewer");
  eq([(await seen(so2, day(20))).length, (await seen(so3, day(20))).length, (await seen(rm2, day(20), { view: "team" })).length, (await seen(caCalOnly, day(20))).length], [0, 0, 0, 0], "unrelated officers, another team's RM and an admin without Last Payment Report access see nothing");
  eq([(await seen(admin, day(20))).length, (await seen(caBoth, day(20))).length, (await seen(rm, day(20), { view: "team", officerId: "so1" })).length, (await seen(rm, day(20), { view: "team", officerId: "so2" })).length], [1, 1, 1, 0], "authorized admin sees it; the officer filter narrows");
  assert.equal(await code(cal.calendarMonth(rm, { ...monthOf(day(20)), view: "team", officerId: "so3" } as never)), 403, "the filters can never widen an RM's scope");
  for (const who of [so1, rm]) assert.ok((await task.getBillingTaskDetail(who, calTask.id)).billNo, "task details (Bill No, Auth Person…) open for the owner and the supervising RM");
  eq([await code(task.getBillingTaskDetail(so3, calTask.id)), await code(task.getBillingTaskDetail(rm2, calTask.id)), await code(task.getBillingTaskDetail(caCalOnly, calTask.id)), await code(task.getBillingTaskDetail(so2, calTask.id))], [404, 404, 404, 404], "…and stay hidden from everyone else");
  assert.equal(await code(be.createBillingException(rm, input("F", { paymentCondition: "NO" }))), 403, "seeing the task grants no right to create a Billing Exception");
  eq([await prisma.dailyWorkEntry.count(), await prisma.calendarEntry.count()], dwBefore, "Calendar visibility creates no Daily Work row and no Calendar entry");
  assert.equal(await prisma.billingExceptionTask.count({ where: { billingExceptionId: calEx.id } }), 1, "no second (RM) task exists");

  await task.rescheduleBillingTask(so1, calTask.id, day(22));
  const moved2 = await seen(so1, day(22));
  eq([(await seen(so1, day(20))).filter((t) => t.dateKey === day(20)).length, moved2.length, moved2[0]?.dateKey, moved2[0]?.promisedDate, moved2[0]?.rescheduled], [0, 1, day(22), day(20), true], "a reschedule moves the Calendar item and keeps the original promised date");
  assert.equal((await seen(rm, day(22), { view: "team" })).length, 1, "…for the RM too");

  // Ownership before materialization: visibility follows the dealer's CURRENT assignment (the same rule materialization uses).
  const reassign = async (to: string) => { await prisma.dealerAssignment.updateMany({ where: { dealerId: "F", effectiveTo: null }, data: { effectiveTo: new Date(`${day(13)}T00:00:00Z`) } }); await prisma.dealerAssignment.create({ data: { dealerId: "F", officerId: to, effectiveFrom: new Date(`${day(13)}T00:00:00Z`) } }); };
  await reassign("so2");
  eq([(await seen(so1, day(22))).length, (await seen(so2, day(22))).length, (await seen(rm, day(22), { view: "team" })).length, (await seen(so2, day(22)))[0]?.ownerName], [0, 1, 1, "SO2"], "reassigned within the team: the new officer sees it, the old one no longer does, the RM still does");
  assert.equal(await code(task.getBillingTaskDetail(so1, calTask.id)), 404); assert.ok((await task.getBillingTaskDetail(so2, calTask.id)).taskId);
  await reassign("so3");
  eq([(await seen(rm, day(22), { view: "team" })).length, (await seen(rm2, day(22), { view: "team" })).length, (await seen(so3, day(22))).length], [0, 1, 1], "moved to another team: the old RM loses it, the new team's RM gains it");
  await reassign("so2");

  // Due day: exactly one Recovery contribution, and it stays visible with its new status; reading the Calendar never adds anything.
  clock = day(22);
  await materialize("so2", day(22)); await materialize("so2", day(22));
  assert.equal(Number((await entry("so2", day(22), "F"))!.todaysPlan), 7000, "exactly one Recovery contribution");
  for (let i = 0; i < 3; i++) await cal.calendarMonth(rm, { ...monthOf(day(22)), view: "team" } as never);
  assert.equal(Number((await entry("so2", day(22), "F"))!.todaysPlan), 7000, "viewing the Calendar adds nothing");
  eq([(await seen(so2, day(22)))[0]?.status, (await seen(rm, day(22), { view: "team" }))[0]?.status, (await seen(so2, day(22)))[0]?.ownerId], ["IN_DAILY_WORK", "IN_DAILY_WORK", "so2"], "linked task: status In Daily Work, owner fixed by the entry");

  // A missed day: an unlinked task stays on its date, flagged Overdue.
  clock = day(13);
  const lateEx = await be.createBillingException(admin, input("C", { paymentCondition: "YES", paymentDate: day(14), billingAmount: 450, billingDate: day(12) }));
  const lateTask = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { billingExceptionId: lateEx.id } });
  clock = day(16);
  eq((await cal.calendarMonth(so1, monthOf(day(14)) as never)).billingTasks.filter((t) => t.id === lateTask.id).map((t) => [t.dateKey, t.status]), [[day(14), "OVERDUE"]], "a missed, unlinked task stays on its day, marked Overdue");
  clock = day(13);


  /* ---- Recovery Type = the SOURCE of an automatic task: shown, locked, and enforced on the server ---- */
  {
    clock = day(40);
    const ex = await be.createBillingException(admin, input("A", { paymentCondition: "YES", paymentDate: day(41), billingAmount: 900 }));
    const bt = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { billingExceptionId: ex.id } });
    clock = day(41);
    await materialize("so1", day(41));
    await manual("so1", day(41), "B", 100); // a manual row of ANOTHER dealer
    const read = async () => (await svc.getDailyWork(so1, "RECOVERY", day(41), undefined, "PLAN")).dealers;
    const bySource = (rows: Awaited<ReturnType<typeof read>>) => Object.fromEntries(rows.map((r) => [r.dealerId, [r.recoverySource ?? null, r.entryType, r.todaysPlan]]));
    eq(bySource(await read()), { A: ["BILLING_EXCEPTION", "REGULAR", 900], B: [null, "REGULAR", 100], C: ["BILLING_EXCEPTION", "REGULAR", 450] }, "the automatic rows carries its source; the manual row has none; amounts unchanged");
    // Draft save: a manual change of the Recovery Type of the automatic row cannot succeed; a plain re-save keeps everything.
    assert.notEqual(await code(svc.saveDailyWork(so1, { section: "RECOVERY", workDate: day(41), rows: [{ dealerId: "A", todaysPlan: 900, entryType: "SCHEME", schemeId: "forged" }, { dealerId: "B", todaysPlan: 100, entryType: "REGULAR" }, { dealerId: "C", todaysPlan: 450, entryType: "REGULAR" }] })), 0, "a forged Recovery Type is refused");
    await svc.saveDailyWork(so1, { section: "RECOVERY", workDate: day(41), rows: [{ dealerId: "A", todaysPlan: 900, entryType: "REGULAR" }, { dealerId: "B", todaysPlan: 150, entryType: "REGULAR" }, { dealerId: "C", todaysPlan: 450, entryType: "REGULAR" }] });
    eq(bySource(await read()), { A: ["BILLING_EXCEPTION", "REGULAR", 900], B: [null, "REGULAR", 150], C: ["BILLING_EXCEPTION", "REGULAR", 450] }, "draft save/reopen keeps the source and the amounts (the manual row stays editable)");
    assert.equal(await code(svc.saveDailyWork(so1, { section: "RECOVERY", workDate: day(41), rows: [{ dealerId: "A", todaysPlan: 500, entryType: "REGULAR" }, { dealerId: "B", todaysPlan: 150, entryType: "REGULAR" }, { dealerId: "C", todaysPlan: 450, entryType: "REGULAR" }] })), 409, "the task amount floor still applies");
    // The stored financial classification is retained separately: even when it differs from what a request says, the automatic row keeps it.
    await prisma.$executeRaw`UPDATE "DailyWorkEntry" SET "entryType" = 'SCHEME' WHERE "officerId" = 'so1' AND "workDate" = ${day(41)}::date AND "section" = 'RECOVERY' AND "rowKey" = 'A'`;
    await svc.saveDailyWork(so1, { section: "RECOVERY", workDate: day(41), rows: [{ dealerId: "A", todaysPlan: 900, entryType: "REGULAR" }, { dealerId: "B", todaysPlan: 150, entryType: "REGULAR" }, { dealerId: "C", todaysPlan: 450, entryType: "REGULAR" }] });
    eq((await entry("so1", day(41), "A")) && (await prisma.$queryRaw<{ entryType: string }[]>`SELECT "entryType" FROM "DailyWorkEntry" WHERE "officerId" = 'so1' AND "workDate" = ${day(41)}::date AND "section" = 'RECOVERY' AND "rowKey" = 'A'`).map((r) => r.entryType), ["SCHEME"], "a request cannot change an automatic row's stored classification");
    await prisma.$executeRaw`UPDATE "DailyWorkEntry" SET "entryType" = 'REGULAR' WHERE "officerId" = 'so1' AND "workDate" = ${day(41)}::date AND "section" = 'RECOVERY' AND "rowKey" = 'A'`;
    // The automatic amount is locked on the server: nothing manual sits on top of it, so any other amount is refused.
    assert.equal(await code(svc.saveDailyWork(so1, { section: "RECOVERY", workDate: day(41), rows: [{ dealerId: "A", todaysPlan: 901, entryType: "REGULAR" }, { dealerId: "B", todaysPlan: 150, entryType: "REGULAR" }, { dealerId: "C", todaysPlan: 450, entryType: "REGULAR" }] })), 409, "an Auto amount cannot be edited");
    eq((await read()).map((r) => [r.dealerId, r.amountLocked, r.autoContribution]), [["A", true, 900], ["B", false, 0], ["C", true, 450]], "the locked flag reaches the editor");
    assert.equal(await code(svc.saveDailyWork(so1, { section: "RECOVERY", workDate: day(41), rows: [{ dealerId: "B", todaysPlan: 150, entryType: "REGULAR" }, { dealerId: "C", todaysPlan: 450, entryType: "REGULAR" }] })), 409, "an Auto row cannot be removed");
    eq((await read()).find((r) => r.dealerId === "A")?.recoverySource, "BILLING_EXCEPTION");
    // Report view: the same source, and the row is an Auto Task row there too.
    const report = await svc.getDailyWork(so1, "RECOVERY", day(41), undefined, "REPORT");
    assert.ok(Array.isArray(report.autoTaskEntryIds), "report payload keeps the Auto Task id list");
    /* ---- reschedule from the row: same task, gone from today, back on its day; no confirmation anywhere ---- */
    const stale = [{ dealerId: "A", todaysPlan: 900, entryType: "REGULAR", autoAmount: 900 }, { dealerId: "B", todaysPlan: 150, entryType: "REGULAR" }, { dealerId: "C", todaysPlan: 450, entryType: "REGULAR", autoAmount: 450 }];
    await svc.saveDailyWork(so1, { section: "RECOVERY", workDate: day(41), rows: stale }); // the editor's draft, before the move
    await task.rescheduleBillingTask(rm, bt.id, day(44)); // the authorized RM moves it
    eq(bySource(await read()), { B: [null, "REGULAR", 150], C: ["BILLING_EXCEPTION", "REGULAR", 450] }, "the task left today's plan: no row for it, manual row untouched");
    assert.equal(await code(svc.saveDailyWork(so1, { section: "RECOVERY", workDate: day(41), rows: stale })), 409, "a stale draft can not bring the amount back");
    eq(bySource(await read()), { B: [null, "REGULAR", 150], C: ["BILLING_EXCEPTION", "REGULAR", 450] }, "…and nothing was re-created");
    await task.rescheduleBillingTask(rm, bt.id, day(44)); // a retried request
    const moved2 = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: bt.id } });
    eq([moved2.dailyWorkEntryId, moved2.taskDate.toISOString().slice(0, 10), moved2.promisedDate.toISOString().slice(0, 10), moved2.rescheduled, Number(moved2.amount), moved2.officerId], [null, day(44), day(41), true, 900, "so1"], "same task: schedule kept apart from the promised date; amount and owner unchanged");
    assert.equal((await prisma.billingException.findUniqueOrThrow({ where: { id: ex.id } })).paymentDate?.toISOString().slice(0, 10), day(41), "the exception's own promised payment date is not rewritten");
    assert.ok((await prisma.auditLog.findMany({ where: { entity: "billingExceptionTask", entityId: bt.id } })).some((a) => a.summary?.includes(`${day(41)} → ${day(44)}`) && a.userId === "rm"), "who / previous date / new date are audited");
    // The moved task no longer blocks today's submission.
    for (const section of ["SALES", "APPOINTMENT", "VISITS", "OTHERS"]) await svc.setDailyNoPlan(so1, { workDate: day(41), section, noPlan: true });
    await svc.submitDailyWorkDay(so1, { workDate: day(41) });
    // Its scheduled date arrives: the same task enters that day's plan exactly once.
    clock = day(44); await materialize("so1", day(44)); await materialize("so1", day(44));
    const back = await prisma.billingExceptionTask.findUniqueOrThrow({ where: { id: bt.id } });
    eq([back.dailyWorkEntryId !== null, Number((await entry("so1", day(44), "A"))!.todaysPlan)], [true, 900], "back in Today's Plan on its date, once");
    clock = day(13);
  }
  /* ---- atomic: a failing audit rolls the exception AND its task back ---- */
  const counts = [await prisma.billingException.count(), await prisma.billingExceptionTask.count()];
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_audit() RETURNS trigger AS $$ BEGIN IF NEW.entity = 'billingException' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_audit_t BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fail_audit()`);
  assert.notEqual(await code(be.createBillingException(admin, input("C", { paymentCondition: "YES", paymentDate: day(14), billingAmount: 100 }))), 0);
  await prisma.$executeRawUnsafe(`DROP TRIGGER fail_audit_t ON "AuditLog"`);
  eq([await prisma.billingException.count(), await prisma.billingExceptionTask.count()], counts, "no exception without its task, no task without its exception");
  /* ---- Performance → Tasks: one task, its history, the reschedule calendar, scope and the Performance Task Activity — against the REAL database ---- */
  {
    const ana = load<typeof import("@/features/tasks/task-analysis.server")>("src/features/tasks/task-analysis.server.ts");
    const person = (id: string) => ({ id, name: id.toUpperCase(), role: id === "rm" ? "REGIONAL_MANAGER" : "SALES_OFFICER", groupId: "g1", groupName: "MP" });
    const scopeOf = (ids: string[]) => ({ population: ids.map(person), officers: [], states: [] });
    const everyone = scopeOf(["so1", "so2", "rm"]);
    const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
    const base = { from: day(-30), to: day(90), basis: "ORIGINAL" as const, type: "ALL" as const, section: "", source: "", status: "", focusDate: null, page: 1, pageSize: 100 };
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    // The history written by the real reschedules above: t0 was due day(2); so1 → day(5), the RM → day(6) → day(5); the retries and the no-op wrote nothing.
    const evs = await prisma.taskRescheduleEvent.findMany({ where: { sourceType: "BILLING_EXCEPTION", sourceId: t0.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    eq(evs.map((e) => [iso(e.previousDate), iso(e.newDate), e.actorId, e.ownerId]), [[day(2), day(5), "so1", "so1"], [day(5), day(6), "rm", "so1"], [day(6), day(5), "rm", "so1"]], "one immutable event per genuine move: previous, new, actor, owner — retries and same-date saves wrote nothing");
    await assert.rejects(prisma.$executeRaw`UPDATE "TaskRescheduleEvent" SET "newDate" = ${day(9)}::date WHERE "id" = ${evs[0]!.id}`, "history is append-only (update refused)");
    await assert.rejects(prisma.$executeRaw`DELETE FROM "TaskRescheduleEvent" WHERE "id" = ${evs[0]!.id}`, "history is append-only (delete refused)");
    await assert.rejects(prisma.$executeRaw`INSERT INTO "TaskRescheduleEvent" ("id","sourceType","sourceId","ownerId","previousDate","newDate","actorId","actorName","actorRole") VALUES ('x','BILLING_EXCEPTION','y','so1',${day(2)}::date,${day(2)}::date,'so1','So','SALES_OFFICER')`, "a no-op date change cannot be stored");
    const eventCount = await prisma.taskRescheduleEvent.count();
    clock = day(13);
    assert.equal(await code(task.rescheduleBillingTask(so2, t0.id, day(30))), 403); assert.equal(await code(task.rescheduleBillingTask(so1, t0.id, day(-1))), 422);
    assert.equal(await prisma.taskRescheduleEvent.count(), eventCount, "a refused / failed change leaves no history");

    // The task row: Original Due Date stays day(2) (the promised date) while the current date is day(5); one task, three moves, three DISTINCT affected dates.
    const all = plain(await ana.getTaskAnalysis(everyone, base));
    const row = all.rows.find((r: { taskId: string }) => r.taskId === t0.id)!;
    eq([row.type, row.section, row.subtype, row.originalDate, row.currentDate, row.moves, row.daysMoved, row.historyState, row.originalVerified], ["AUTO", "RECOVERY", "BILLING_EXCEPTION", day(2), day(5), 3, 3, "COMPLETE", true]);
    assert.equal(all.rows.filter((r: { taskId: string }) => r.taskId === t0.id).length, 1, "one row per distinct task");
    // Counting rules reconcile with the database: distinct moved tasks, recorded events, average = events ÷ tasks, statuses add up.
    const movedTasks = new Set((await prisma.taskRescheduleEvent.findMany({ select: { sourceType: true, sourceId: true } })).map((e) => `${e.sourceType}:${e.sourceId}`));
    const totalEvents = await prisma.taskRescheduleEvent.count();
    const sm = all.summary;
    eq([sm.rescheduledTasks, sm.totalReschedules], [movedTasks.size, totalEvents], "Tasks Rescheduled = distinct moved tasks; Total Reschedules = recorded date changes");
    eq([sm.averageReschedules, sm.completed + sm.pending + sm.overdue + sm.cancelled], [Math.round((totalEvents / sm.total) * 100) / 100, sm.total], "average = total reschedules ÷ total tasks; every task has exactly one status");
    assert.equal(all.rows.filter((r: { sourceType: string }) => r.sourceType === "BILLING_EXCEPTION").length, await prisma.billingExceptionTask.count(), "every Billing task once — its materialized Daily Work row is not a second task");
    for (const r of all.rows.filter((x: { sourceType: string }) => x.sourceType === "DAILY_WORK_ROW")) {
      const [chk] = await prisma.$queryRaw<{ residual: string }[]>`SELECT (w."todaysPlan" - COALESCE((SELECT SUM("dailyWorkContribution") FROM "BillingExceptionTask" WHERE "dailyWorkEntryId" = w."id"),0) - COALESCE((SELECT SUM("dailyWorkContribution") FROM "CalendarEntry" WHERE "dailyWorkEntryId" = w."id"),0))::text AS residual FROM "DailyWorkEntry" w WHERE w."id" = ${r.taskId}`;
      assert.ok(Number(chk!.residual) > 0 && r.type === "MANUAL", "a Daily Work row is a MANUAL task only for its manual part");
    }
    assert.ok(all.rows.some((r: { type: string; sourceType: string }) => r.type === "MANUAL" && r.sourceType === "CALENDAR_ENTRY") && all.rows.every((r: { sourceType: string; type: string }) => (r.sourceType === "CALENDAR_ENTRY" || r.sourceType === "DAILY_WORK_ROW") === (r.type === "MANUAL")), "Calendar tasks are Manual, workflow tasks Auto; no third type");
    assert.equal(await prisma.calendarEntry.count({ where: { kind: { not: "TASK" } } }) >= 1 && !all.rows.some((r: { sourceType: string; taskId: string }) => r.sourceType === "CALENDAR_ENTRY" && r.taskId === rAssigned.id), true, "reminders are not tasks");
    const autoOnly = plain(await ana.getTaskAnalysis(everyone, { ...base, type: "AUTO" })), manualOnly = plain(await ana.getTaskAnalysis(everyone, { ...base, type: "MANUAL" }));
    eq(autoOnly.summary.total + manualOnly.summary.total, sm.total, "Auto + Manual = All");
    // Original-date filtering: a task moved OUT of a window stays in its original window, and is absent from a window of its CURRENT date only.
    const orig = plain(await ana.getTaskAnalysis(everyone, { ...base, from: day(2), to: day(2) })), cur = plain(await ana.getTaskAnalysis(everyone, { ...base, from: day(5), to: day(5) }));
    assert.ok(orig.rows.some((r: { taskId: string }) => r.taskId === t0.id), "still listed under its Original Due Date after being rescheduled");
    assert.ok(!cur.rows.some((r: { taskId: string }) => r.taskId === t0.id), "not listed under a date it was merely moved to");
    // Status rules: Completed only from source evidence; Pending / Overdue by the CURRENT scheduled date against today.
    clock = day(5);
    const st = plain(await ana.getTaskAnalysis(everyone, { ...base })).rows.find((r: { taskId: string }) => r.taskId === t0.id)!;
    // A Billing task is Completed only through its exception being Resolved by a payment — never by being in Daily Work, confirmed, or rescheduled.
    const paid = await prisma.billingException.count({ where: { id: yes.id, status: "RESOLVED", resolutionReason: "PAYMENT_RECEIVED" } });
    eq([st.status === "COMPLETED"], [paid === 1], "completion follows the exception's real payment resolution");
    const open = plain(await ana.getTaskAnalysis(everyone, { ...base })).rows.filter((r: { sourceType: string; taskId: string }) => r.sourceType === "BILLING_EXCEPTION" && r.taskId !== t0.id);
    for (const r of open) {
      const be = await prisma.billingException.findFirstOrThrow({ where: { task: { id: r.taskId } } });
      eq([r.status === "COMPLETED"], [be.status === "RESOLVED" && be.resolutionReason === "PAYMENT_RECEIVED"], `task ${r.taskId}: completed only when its exception is resolved by payment`);
      if (r.status !== "COMPLETED") eq([r.status], [r.currentDate < day(5) ? "OVERDUE" : "PENDING"], "open: Overdue when the CURRENT date has passed, otherwise Pending");
    }

    // Reschedule calendar: counts distinct tasks per scheduled date; t0 (2 → 5 → 6 → 5) is ONE task on days 2, 5 and 6 (the revisit is counted once).
    const month = day(2).slice(0, 7);
    const cal = plain(await ana.getRescheduleCalendar(everyone, base, month));
    const expected = new Map<string, Set<string>>();
    for (const e of await prisma.taskRescheduleEvent.findMany()) for (const d of [iso(e.previousDate), iso(e.newDate)]) if (d.startsWith(month)) { const k = `${e.sourceType}:${e.sourceId}`; expected.set(d, (expected.get(d) ?? new Set()).add(k)); }
    eq(Object.fromEntries([...expected].map(([d, set]) => [d, set.size]).sort()), Object.fromEntries(Object.entries(cal.days).sort()), "calendar intensity = distinct rescheduled tasks per scheduled date");
    for (const d of [day(2), day(5), day(6)]) assert.ok((cal.days[d] ?? 0) >= 1, `t0 contributes to ${d}`);
    eq([cal.periodTasks], [movedTasks.size], "period total = distinct rescheduled tasks in the filtered population");
    // Date focus narrows the table only.
    const focus = plain(await ana.getTaskAnalysis(everyone, { ...base, focusDate: day(6) }));
    assert.ok(focus.rows.some((r: { taskId: string }) => r.taskId === t0.id) && focus.rows.every((r: { moves: number }) => r.moves > 0), "only rescheduled tasks involving that date");
    eq([focus.focusCount, focus.summary.total], [focus.rows.length, sm.total], "the focus count is the table; the summary is unchanged");

    // Full history of one task; scope.
    const hist = plain(await ana.getTaskHistory(everyone, "BILLING_EXCEPTION", t0.id));
    eq([hist.events.map((e: { previousDate: string; newDate: string; actorName: string }) => [e.previousDate, e.newDate, e.actorName]), hist.trail, hist.chainOk, hist.distinctDates], [[[day(2), day(5), "SO1"], [day(5), day(6), "RM"], [day(6), day(5), "RM"]], [day(2), day(5), day(6), day(5)], true, [day(2), day(5), day(6)]], "chronological, with the revisit kept in the trail");
    assert.equal(await code(ana.getTaskHistory(scopeOf(["so2"]), "BILLING_EXCEPTION", t0.id)), 404, "another employee's task looks missing");
    eq(plain(await ana.getTaskAnalysis(scopeOf(["so2"]), base)).rows.some((r: { ownerId: string }) => r.ownerId === "so1"), false, "an SO's list never includes a colleague's tasks");
    eq(plain(await ana.getTaskAnalysis(scopeOf([]), base)).summary, { total: 0, completed: 0, pending: 0, overdue: 0, cancelled: 0, rescheduledTasks: 0, totalReschedules: 0, averageReschedules: 0, incompleteHistory: 0 }, "an empty population: zeros, no division error");

    // Rescheduled On: the business (IST) day each change was MADE — the events above were made today (real clock), not on any scheduled date.
    const madeOn = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const byMade = plain(await ana.getTaskAnalysis(everyone, { ...base, basis: "RESCHEDULED_ON", from: madeOn, to: madeOn }));
    const t0Made = byMade.rows.find((r: { taskId: string }) => r.taskId === t0.id)!;
    eq([t0Made.periodMoves, byMade.rows.every((r: { moves: number }) => r.moves > 0)], [3, true], "tasks with a change made on that day, with the changes made that day");
    eq(plain(await ana.getTaskAnalysis(everyone, { ...base, basis: "RESCHEDULED_ON", from: day(2), to: day(2) })).rows.length, 0, "a scheduled date is not an action date: nothing was MADE on it");
    // Performance Task Activity: tasks originally scheduled for the row's date + reschedules made on it, in two batch queries.
    const act = await ana.getTaskActivity(everyone, day(2), day(2));
    const expectedTasks = plain(await ana.getTaskAnalysis(everyone, { ...base, from: day(2), to: day(2) })).rows.filter((r: { ownerId: string }) => r.ownerId === "so1").length;
    eq(act.get(`so1|${day(2)}`)?.tasks, expectedTasks, "task count = distinct tasks originally scheduled for that employee / date");
    const actToday = await ana.getTaskActivity(everyone, madeOn, madeOn);
    eq(actToday.get(`so1|${madeOn}`)?.reschedules, await prisma.taskRescheduleEvent.count({ where: { ownerId: "so1" } }), "reschedules = changes made on that day for that employee's tasks (whatever dates they were scheduled for)");

    // CN sources (Auto, source CN Request): a CN Recovery task and a legacy CN follow-up, with the real recorder used by the CN reschedule paths.
    const hist2 = load<typeof import("@/features/tasks/task-history.server")>("src/features/tasks/task-history.server.ts");
    const cn = await prisma.cnRequest.create({ data: { officerId: "so1", dealerId: "A", cnType: "RATE_DIFFERENCE", status: "ACCEPTED_NOT_POSTED", paymentTrackingMode: "PAYMENT_V1", acceptanceReason: "PAYMENT_PENDING" } as never });
    const ev = (key: string, over: Record<string, unknown>) => prisma.cnPaymentEvent.create({ data: { cnRequestId: cn.id, status: "PENDING", eventDate: new Date(day(0)), outstandingBefore: 100, outstandingAfter: 100, source: "ACCEPTANCE", requestKey: key, recordedById: "admin", taskAmount: 5000, taskStatus: "SCHEDULED", taskDate: new Date(day(20)), ...over } });
    const cnMoved = await ev("cn-moved", {}), cnDone = await ev("cn-done", { taskStatus: "COMPLETED", taskAmount: 700, taskDate: new Date(day(21)) }), cnGap = await ev("cn-gap", { taskDate: new Date(day(22)), taskRescheduled: true, rescheduleHistoryGap: true });
    await prisma.$transaction(async (tx) => { // what scheduleCnTask does for an already-dated task: the date update + its history row, together
      await tx.cnPaymentEvent.update({ where: { id: cnMoved.id }, data: { taskDate: new Date(day(24)), taskRescheduled: true } });
      await hist2.recordTaskReschedule(tx, so1, { sourceType: "CN_PAYMENT", sourceId: cnMoved.id, ownerId: "so1", previousDate: day(20), newDate: day(24) });
      eq(await hist2.recordTaskReschedule(tx, so1, { sourceType: "CN_PAYMENT", sourceId: cnMoved.id, ownerId: "so1", previousDate: day(24), newDate: day(24) }), false, "a save to the same date is not a reschedule");
    });
    const legacyCn = await prisma.cnRequest.create({ data: { officerId: "so1", dealerId: "B", cnType: "RATE_DIFFERENCE", status: "ACCEPTED_NOT_POSTED", acceptanceReason: "PAYMENT_PENDING", amount: 300, taskDate: new Date(day(23)), rescheduleHistoryGap: true } as never });
    const cnRows = plain(await ana.getTaskAnalysis(everyone, { ...base, type: "AUTO", source: "CN_REQUEST" })).rows as { taskId: string; sourceType: string; type: string; subtype: string; status: string; historyState: string; moves: number; originalDate: string; currentDate: string; originalVerified: boolean; amount: number; daysMoved: number | null }[];
    const by = (id: string) => cnRows.find((r) => r.taskId === id)!;
    eq([by(cnMoved.id).sourceType, by(cnMoved.id).type, by(cnMoved.id).subtype, by(cnMoved.id).originalDate, by(cnMoved.id).currentDate, by(cnMoved.id).moves, by(cnMoved.id).daysMoved, by(cnMoved.id).historyState, by(cnMoved.id).originalVerified, by(cnMoved.id).amount], ["CN_PAYMENT", "AUTO", "CN_REQUEST", day(20), day(24), 1, 4, "COMPLETE", true, 5000], "CN task: Auto / CN Request, original kept, one recorded move");
    eq([by(cnDone.id).status, by(cnMoved.id).status === "COMPLETED"], ["COMPLETED", false], "completed through the task's own closure, not by being scheduled");
    eq([by(cnGap.id).historyState, by(cnGap.id).originalVerified, by(cnGap.id).daysMoved, by(cnGap.id).moves], ["UNAVAILABLE", false, null, 0], "a CN task flagged before history existed: unavailable, original unverified, days moved unknown");
    eq([by(legacyCn.id).sourceType, by(legacyCn.id).historyState, by(legacyCn.id).status, by(legacyCn.id).amount], ["CN_LEGACY", "UNAVAILABLE", "PENDING", 300], "legacy CN follow-up: Auto, history unavailable, open and not yet due (Pending)");
    assert.equal(cnRows.filter((r) => r.taskId === cnMoved.id).length, 1, "one row per CN task");

    // Legacy: a task moved before history existed is NOT shown as a verified zero.
    const legacy = await prisma.billingExceptionTask.findFirstOrThrow({ where: { id: { not: t0.id }, rescheduled: false, NOT: { id: { in: [...movedTasks].map((k) => k.split(":")[1]!) } } } });
    await prisma.billingExceptionTask.update({ where: { id: legacy.id }, data: { rescheduled: true, rescheduleHistoryGap: true } });
    const lg = plain(await ana.getTaskAnalysis(everyone, base)).rows.find((r: { taskId: string }) => r.taskId === legacy.id)!;
    eq([lg.historyState, lg.moves], ["UNAVAILABLE", 0], "flagged as moved but no recorded history → History unavailable, never a verified zero");
    const lgAll = plain(await ana.getTaskAnalysis(everyone, base));
    eq([lgAll.summary.incompleteHistory >= 1, lgAll.summary.totalReschedules], [true, await prisma.taskRescheduleEvent.count()], "its unknown moves are not added to Total Reschedules");
  }
  console.log("billing-task.integration.ts — all assertions passed");
}
main().then(() => prisma.$disconnect(), async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
