/**
 * Daily Report deadlines + late-submission approval against a REAL, disposable PostgreSQL database, with a controlled business clock: SO midnight vs RM noon, the persisted rollout and
 * per-day policy, the outstanding-report block (any number of absent days), skipped dates, requests / decisions (atomic, scoped), an approval that stays open until final submission,
 * Performance (Missed / Late) and pre-rollout behaviour.
 *
 *   BILLING_TASK_TEST_URL=postgresql://localhost:5432/billing_task_test npm run test:report-policy:db
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  "@/lib/scope": { getCurrentOwnerByDealer: async (ids: string[]) => { const rows = await prisma.dealerAssignment.findMany({ where: { dealerId: { in: ids }, effectiveTo: null }, orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }] }); return new Map(rows.map((r) => [r.dealerId, r.officerId])); }, getCurrentDealerIds: async (id: string) => { const mine = [...new Set((await prisma.dealerAssignment.findMany({ where: { officerId: id, effectiveTo: null } })).map((a) => a.dealerId))]; const rows = await prisma.dealerAssignment.findMany({ where: { dealerId: { in: mine }, effectiveTo: null }, orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }] }); const owner = new Map(rows.map((r) => [r.dealerId, r.officerId])); return mine.filter((d) => owner.get(d) === id); }, getOfficerScope: async (c: AuthContext) => (c.role === Role.REGIONAL_MANAGER && c.groupId ? { all: false, ids: [c.userId, ...(await prisma.user.findMany({ where: { role: Role.SALES_OFFICER, groupId: c.groupId, isActive: true, deletedAt: null }, select: { id: true } })).map((u) => u.id)] } : { all: false, ids: [c.userId] }), assertOfficerInScope: async () => undefined },
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
const feedback = load<typeof import("./report-policy.server")>("src/features/daily-work/report-policy.server.ts");

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
  svc.enterTaskOutcomes(c, { section, workDate: date, entries: [{ entryId: r.entryId, ...(section === "RECOVERY" ? { paymentMode: "CASH" } : {}), units: [{ unitType: unitOf(r).unitType, unitId: unitOf(r).unitId, ...f }] }] });
const counts = async () => ({
  outcomes: await prisma.dailyTaskOutcome.count(), committed: await prisma.dailyTaskOutcome.count({ where: { state: "COMMITTED" } }), calendar: await prisma.calendarEntry.count(),
  events: await prisma.taskRescheduleEvent.count(), receipts: await prisma.dealerPaymentReceipt.count(), exceptions: await prisma.billingException.count(), tasks: await prisma.billingExceptionTask.count(),
});
const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
/** Pin the business clock to an IST wall time. */
const at = (date: string, time: string) => { const instant = new Date(`${date}T${time}+05:30`); realDailyWork.dailyWorkClock.now = () => instant; clock = realDailyWork.currentBusinessDate(instant); };
const ist = (iso: string) => new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" });
const ALL = ["APPOINTMENT", "VISITS", "OTHERS"];

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "LateReportRequest","DailyReportPolicy","CalendarEntry","DailyTaskOutcome","DailyWorkEntry","DailyWorkDay","DealerAssignment","Dealer","AuditLog","Notification","TaskRescheduleEvent","User","UserGroup" CASCADE`);
  await prisma.userGroup.createMany({ data: [{ id: "g1", name: "MP" }, { id: "g2", name: "UP" }] });
  const mk = (id: string, name: string, role: Role, groupId: string | null, extra: Record<string, unknown> = {}) => prisma.user.create({ data: { id, name, username: id, passwordHash: "x", role, groupId, ...extra } as never });
  await mk("rm", "Rita RM", Role.REGIONAL_MANAGER, "g1"); await mk("so1", "Bina", Role.SALES_OFFICER, "g1", { territory: "Raigarh" }); await mk("so2", "Anil", Role.SALES_OFFICER, "g1");
  await mk("rm2", "Other RM", Role.REGIONAL_MANAGER, "g2"); await mk("admin", "Admin", Role.SUPER_ADMIN, null); await mk("ca", "Custom Admin", Role.CUSTOM_ADMIN, null);
  for (const [id, name, owner] of [["A", "Alpha", "so1"], ["B", "Beta", "so1"], ["C", "Gamma", "so2"], ["R", "Rita Own", "rm"]] as const) { await prisma.dealer.create({ data: { id, name } }); await prisma.dealerAssignment.create({ data: { dealerId: id, officerId: owner, effectiveFrom: new Date("2024-01-01") } }); }
  const SO1 = ctx("so1", Role.SALES_OFFICER, "g1"), SO2 = ctx("so2", Role.SALES_OFFICER, "g1"), RM = ctx("rm", Role.REGIONAL_MANAGER, "g1"), RM2 = ctx("rm2", Role.REGIONAL_MANAGER, "g2");
  const ADMIN = ctx("admin", Role.SUPER_ADMIN, null), CA = ctx("ca", Role.CUSTOM_ADMIN, null, { performance: ["read"] }), CA2 = ctx("ca", Role.CUSTOM_ADMIN, null, { performance: ["read", "lateReports"] });
  const ROLLOUT = "2026-10-10T00:00:00Z";
  await prisma.$executeRaw`UPDATE "DailyReportRollout" SET "effectiveAt" = ${new Date(ROLLOUT)} WHERE "id" = 'SO_MIDNIGHT'`;
  assert.ok((await prisma.dailyReportRollout.findMany()).length === 1, "the rollout cutoff is persisted");

  const plan = async (c: AuthContext, date: string, dealer: string, amount = 1000) => {
    await svc.saveDailyWork(c, { section: "SALES", workDate: date, rows: [{ dealerId: dealer, todaysPlan: amount, entryType: "REGULAR" }] });
    await noPlan(c, date, ["RECOVERY", ...ALL]);
    await svc.submitDailyWorkDay(c, { workDate: date });
  };
  const rowsReport = async (c: AuthContext, date: string) => (await svc.getDailyWork(c, "SALES", date, undefined, "REPORT")).dealers;
  const draftComplete = async (c: AuthContext, date: string) => {
    const rows = await rowsReport(c, date);
    return svc.enterTaskOutcomes(c, { section: "SALES", workDate: date, entries: rows.map((r) => ({ entryId: r.entryId, units: [{ unitType: r.tasks![0]!.unitType, unitId: r.tasks![0]!.unitId, outcome: "COMPLETED", actualAmount: r.todaysPlan }] })) });
  };
  const submit = (c: AuthContext, date: string) => svc.submitDailyReport(c, { workDate: date, selfRating: 7 });
  const policy = (officer: string, date: string) => prisma.dailyReportPolicy.findUnique({ where: { officerId_workDate: { officerId: officer, workDate: new Date(`${date}T00:00:00Z`) } } });

  /* ---- 1. SO policy: persisted at the first submitted plan; midnight boundary is OUTSIDE; an RM keeps noon ---- */
  at("2026-10-19", "10:30:00");
  await plan(SO1, "2026-10-19", "A");
  await plan(RM, "2026-10-19", "R");
  const p19 = await policy("so1", "2026-10-19");
  same([p19?.version, ist(p19!.deadline.toISOString())], ["SO_MIDNIGHT", "2026-10-20 00:00:00"], "SO: the report closes at 00:00 IST of the next day");
  assert.equal(await policy("rm", "2026-10-19"), null, "an RM has no new-policy row: the previous noon rule stands");
  at("2026-10-19", "18:00:00");
  await svc.saveDailyWork(SO1, { section: "SALES", workDate: "2026-10-19", rows: [{ dealerId: "B", todaysPlan: 50, entryType: "REGULAR" }] }); // a second batch of the day
  await noPlan(SO1, "2026-10-19", ["RECOVERY", ...ALL]);
  await svc.submitDailyWorkDay(SO1, { workDate: "2026-10-19" });
  same(ist((await policy("so1", "2026-10-19"))!.deadline.toISOString()), "2026-10-20 00:00:00", "a later batch of the same date neither changes the policy nor restarts the window");
  assert.equal(await prisma.dailyReportPolicy.count({ where: { officerId: "so1" } }), 1);
  // 23:59:59 IST still accepted; 00:00:00 IST is outside.
  at("2026-10-19", "23:59:59");
  assert.equal((await draftComplete(SO1, "2026-10-19")).count > 0, true, "SO: 23:59:59 accepted");
  at("2026-10-20", "00:00:00");
  assert.equal(await code(draftComplete(SO1, "2026-10-19")), 422, "SO: at midnight the draft write is refused");
  assert.equal(await code(submit(SO1, "2026-10-19")), 422, "…and so is the final submission");
  // RM: noon rule unchanged (11:59:59 ok on the 20th, 12:00:01 refused).
  at("2026-10-20", "11:59:59");
  await svc.enterTaskOutcomes(RM, { section: "SALES", workDate: "2026-10-19", entries: [{ entryId: (await rowsReport(RM, "2026-10-19"))[0]!.entryId, units: [{ unitType: "MANUAL_ROW", unitId: (await rowsReport(RM, "2026-10-19"))[0]!.entryId, outcome: "COMPLETED", actualAmount: 1000 }] }] });
  at("2026-10-20", "12:00:01");
  assert.equal(await code(submit(RM, "2026-10-19")), 422, "RM: after noon the report is closed (unchanged)");
  const viewing = await svc.getDailyStatus(ADMIN, "2026-10-19", "so1");
  assert.equal(viewing.reportDeadline, p19!.deadline.toISOString(), "an admin viewing an SO's report sees the SO's deadline, not the viewer's");
  assert.equal((await svc.getDailyStatus(ADMIN, "2026-10-19", "rm")).reportDeadline, new Date("2026-10-20T12:00:00+05:30").toISOString(), "…and the RM's report keeps the RM's noon deadline");

  /* ---- 2. the block: several absent days; no bypass by refresh, tab or direct API ---- */
  at("2026-10-22", "09:00:00");
  const status = await svc.getDailyStatus(SO1, "2026-10-22");
  same([status.outstandingReport?.date, status.canSubmit, status.outstandingReport?.canRequest], ["2026-10-19", false, true]);
  const blocked = [
    code(svc.saveDailyWork(SO1, { section: "SALES", workDate: "2026-10-22", rows: [{ dealerId: "A", todaysPlan: 5, entryType: "REGULAR" }] })),
    code(svc.setDailyNoPlan(SO1, { workDate: "2026-10-22", section: "RECOVERY", noPlan: true })),
    code(svc.submitDailyWorkDay(SO1, { workDate: "2026-10-22" })),
  ];
  same(await Promise.all(blocked), [423, 423, 423], "create / edit / save / submit are refused on the server (tabs and direct calls hit the same gate)");
  assert.equal(await prisma.dailyWorkEntry.count({ where: { officerId: "so1", workDate: new Date("2026-10-22T00:00:00Z") } }), 0, "nothing was written");
  // The outstanding report keeps its original tasks and saved answers; it is not replaced by an empty report.
  const kept = await rowsReport(SO1, "2026-10-19");
  same(kept.map((r) => [r.dealerId, r.todaysPlan, r.tasks![0]!.outcome]), [["A", 1000, "COMPLETED"], ["B", 50, "COMPLETED"]], "the original tasks, planned values and saved report answers are retained");
  assert.equal(await svc.resolveReportDateForOwner(SO1, "2026-10-19"), "2026-10-19", "the exact older outstanding date is honoured");
  assert.equal(await code(svc.resolveReportDateForOwner(SO1, "2026-10-20")), 403, "a skipped date is not available (never silently turned into today)");
  assert.equal(await code(svc.resolveReportDateForOwner(SO2, "2026-10-19")), 403, "another employee's report date is refused");
  assert.equal(await svc.resolveReportDateForOwner(SO1, "2026-10-21"), "2026-10-21", "yesterday keeps working as before");
  // RM behaviour unchanged: plan allowed (its 19 Oct report is simply Missed under the previous rules).
  await plan(RM, "2026-10-22", "R");

  /* ---- 3. requests: only for a real, overdue, unfinished report with a submitted plan ---- */
  const req = (c: AuthContext, date: string, reason: string) => svc.requestLateReport(c, { workDate: date, reason });
  const REASON = "I was on the road without any network all evening";
  assert.equal(await code(req(SO1, "2026-10-20", REASON)), 422, "a skipped date cannot be requested");
  assert.equal(await code(req(SO2, "2026-10-19", REASON)), 422, "another employee's report cannot be requested");
  assert.equal(await code(req(RM, "2026-10-19", REASON)), 403, "an RM is not a requester");
  assert.equal(await code(req(SO1, "2026-10-19", "short")), 422, "a meaningful reason is required");
  assert.equal(await code(req(SO1, "2026-10-22", REASON)), 422, "a report that is not overdue / has no plan cannot be requested");
  const r1 = await req(SO1, "2026-10-19", REASON);
  same(await feedback.ownLateReportRequestStatus(SO1, "2026-10-19"), { id: r1.id, status: "PENDING" }, "the lightweight refresh sees this SO's pending request");
  assert.equal(await feedback.ownLateReportRequestStatus(SO2, "2026-10-19"), null, "another SO cannot read the request through the refresh endpoint");
  assert.equal(await code(feedback.ownLateReportRequestStatus(RM, "2026-10-19")), 403, "reviewers use their scoped Requests list instead");
  same([r1.status, r1.workDate, r1.reason, ist(r1.deadline)], ["PENDING", "2026-10-19", REASON, "2026-10-20 00:00:00"], "reason, report date and original deadline are kept");
  assert.equal(await code(req(SO1, "2026-10-19", REASON + " again")), 409, "no duplicate pending request");
  assert.equal(await code(draftComplete(SO1, "2026-10-19")), 422, "the report stays read-only while the request is pending");
  // Reviewers: RM of the team / authorized admin; never an SO, another RM or an unauthorized custom admin.
  const decide = (c: AuthContext, id: string, body: Record<string, unknown>) => svc.decideLateReport(c, id, body);
  assert.equal(await code(decide(SO1, r1.id, { action: "approve" })), 403, "an SO cannot decide");
  assert.equal(await code(decide(SO2, r1.id, { action: "approve" })), 403);
  assert.equal(await code(decide(RM2, r1.id, { action: "approve" })), 403, "another RM's scope excludes this officer");
  assert.equal(await code(decide(CA, r1.id, { action: "approve" })), 403, "a custom admin without the permission cannot decide");
  assert.equal(await code(svc.listLateReportRequests(SO1, "pending")), 403, "an SO cannot open the list");
  same((await svc.listLateReportRequests(RM, "pending")).map((r) => [r.id, r.officerName, r.territory, r.state]), [[r1.id, "Bina", "Raigarh", "MP"]], "the RM sees their team's pending requests (identity, territory, state)");
  same([(await svc.listLateReportRequests(RM2, "pending")).length, (await svc.listLateReportRequests(CA, "pending")).length, (await svc.listLateReportRequests(ADMIN, "pending")).length], [0, 1, 1], "other RM: none; custom admin with Performance read: sees; super admin sees");
  // Reject needs an explanation; a rejection leaves the report read-only; a revised request is allowed and history is kept.
  assert.equal(await code(decide(RM, r1.id, { action: "reject" })), 422);
  const rejected = await decide(RM, r1.id, { action: "reject", reason: "Please explain the missing evening more clearly" });
  same([rejected.status, rejected.decidedByName, rejected.decisionReason !== null], ["REJECTED", "Rita RM", true]);
  assert.equal(await code(decide(ADMIN, r1.id, { action: "approve" })), 409, "a stale second decision cannot overwrite the first");
  assert.equal(await code(draftComplete(SO1, "2026-10-19")), 422, "still read-only after a rejection");
  const r2 = await req(SO1, "2026-10-19", REASON + " — revised with more detail");
  same((await myLate(SO1, "2026-10-19")).map((r) => r.status), ["PENDING", "REJECTED"], "history keeps the rejected request");
  // Concurrent decisions: exactly one wins, the others are refused; one approval is enough (here by the authorized admin).
  const race = await Promise.all([decide(RM, r2.id, { action: "approve" }), decide(ADMIN, r2.id, { action: "approve" }), decide(RM, r2.id, { action: "reject", reason: "no longer valid at all" }), decide(CA2, r2.id, { action: "approve" })].map((p) => code(p)));
  same(race.filter((x) => x === 0).length, 1, "exactly one concurrent decision succeeds");
  assert.equal((await prisma.lateReportRequest.findMany({ where: { status: "APPROVED" } })).length, 1);
  same(await feedback.ownLateReportRequestStatus(SO1, "2026-10-19"), { id: r2.id, status: "APPROVED" }, "the refresh sees the decision for the latest request, not its earlier rejected request");
  assert.equal(await code(req(SO1, "2026-10-19", REASON + " third")), 409, "already approved: no further request is needed");

  /* ---- 4. an approved report stays open across days until it is finally submitted; the current plan stays blocked ---- */
  at("2026-10-23", "08:00:00"); // another midnight has passed
  const w = await svc.getDailyStatus(SO1, "2026-10-19");
  same([w.reportApproved, w.reportDeadlinePassed, w.reportMissed], [true, false, true], "approved → editable; it still counts as Missed until submitted");
  assert.equal(await code(svc.saveDailyWork(SO1, { section: "SALES", workDate: "2026-10-23", rows: [{ dealerId: "A", todaysPlan: 5, entryType: "REGULAR" }] })), 423, "the current plan stays blocked while the approval is outstanding");
  // Approval does not unlock the original plan: its dealers / planned amounts cannot be edited.
  assert.notEqual(await code(svc.saveDailyWork(SO1, { section: "SALES", workDate: "2026-10-19", rows: [{ dealerId: "A", todaysPlan: 9999, entryType: "REGULAR" }] })), 0, "the original plan is not editable");
  assert.equal(Number((await prisma.dailyWorkEntry.findFirstOrThrow({ where: { officerId: "so1", workDate: new Date("2026-10-19T00:00:00Z"), dealerId: "A" } })).todaysPlan), 1000);
  // A reschedule date must be after the ACTUAL current business date (23 Oct), not after the report's own date.
  const one = (outcome: string | null, extra: Record<string, unknown> = {}) => svc.enterTaskOutcomes(SO1, { section: "SALES", workDate: "2026-10-19", entries: [{ entryId: kept[0]!.entryId, units: [{ unitType: "MANUAL_ROW", unitId: kept[0]!.entryId, outcome, ...extra }] }] });
  assert.equal(await code(one("RESCHEDULED", { nextDate: "2026-10-22" })), 422, "a date in the past (relative to the report) is refused");
  assert.equal(await code(one("RESCHEDULED", { nextDate: "2026-10-23" })), 422, "…and so is the current date: it must be strictly after today");
  // Failed finalization keeps both the saved answers and the approval.
  await one(null);
  assert.equal(await code(submit(SO1, "2026-10-19")), 422, "an unfinished report cannot be finalized");
  same([(await prisma.lateReportRequest.findFirstOrThrow({ where: { status: "APPROVED" } })).status, await prisma.calendarEntry.count(), await prisma.taskRescheduleEvent.count()], ["APPROVED", 0, 0], "failure retained the approval; no task was created or moved");
  await one("RESCHEDULED", { nextDate: "2026-10-24" });
  const before = await prisma.taskRescheduleEvent.count();
  assert.equal((await submit(SO1, "2026-10-19")).ok, true, "the approved late report is finally submitted");
  assert.equal(await code(submit(SO1, "2026-10-19")), 409, "…exactly once");
  same([(await prisma.lateReportRequest.findFirstOrThrow({ where: { workDate: new Date("2026-10-19T00:00:00Z"), status: "COMPLETED" } })).status, await prisma.taskRescheduleEvent.count() - before, await prisma.calendarEntry.count()], ["COMPLETED", 1, 1], "the approval is consumed; one reschedule event and one continuing task — no duplicates");
  const done = await prisma.dailyWorkDay.findFirstOrThrow({ where: { officerId: "so1", workDate: new Date("2026-10-19T00:00:00Z") } });
  assert.ok(done.status === "FINALIZED" && done.finalizedAt, "finalized with the real submission timestamp (the database clock)");
  assert.equal((await svc.getDailyStatus(SO1, "2026-10-23")).outstandingReport, null, "today's plan is unlocked");
  await plan(SO1, "2026-10-23", "A");

  /* ---- 5. Performance: original work date, real submission, Late; skipped dates Missed in both columns ---- */
  const perf = await svc.getDailyPerformance(ADMIN, { from: "2026-10-08", to: "2026-10-24" });
  const row = (o: string, d: string) => perf.rows.find((r) => r.officerId === o && r.date === d)!;
  same([row("so1", "2026-10-19").submitted, row("so1", "2026-10-19").reportSubmittedAt !== null, row("so1", "2026-10-19").lateReport, row("so1", "2026-10-19").reportMissed], [true, true, { open: null, late: true }, false], "the report stays on 19 Oct with its real submission time, flagged Late; not Missed");
  same([row("so1", "2026-10-20").planMissed, row("so1", "2026-10-20").reportMissed, row("so1", "2026-10-21").planMissed, row("so1", "2026-10-21").reportMissed], [true, true, true, true], "skipped dates: Missed in BOTH columns");
  same([row("so1", "2026-10-09").planMissed, row("so1", "2026-10-09").reportMissed], [false, false], "dates before the rollout are not retroactively Missed");
  same([row("so1", "2026-10-24").planMissed, row("so1", "2026-10-24").reportMissed], [false, false], "future dates are not Missed");
  assert.equal(row("rm", "2026-10-20").planMissed, false, "the new display policy is for Sales Officers");
  assert.equal(perf.summary.submittedReports, 1, "the late report is counted once, as a submitted report");
  assert.equal(await code(req(SO1, "2026-10-20", REASON)), 422, "skipped dates stay unavailable for requests");
  assert.equal(await prisma.dailyWorkEntry.count({ where: { officerId: "so1", workDate: new Date("2026-10-20T00:00:00Z") } }), 0, "no fake plan, report or task exists for a skipped date");

  /* ---- 6. pre-rollout plans keep the previous rules ---- */
  await prisma.$executeRaw`UPDATE "DailyReportRollout" SET "effectiveAt" = ${new Date("2026-10-26T00:00:00Z")} WHERE "id" = 'SO_MIDNIGHT'`;
  at("2026-10-25", "10:00:00");
  await plan(SO2, "2026-10-25", "C");
  assert.equal(await policy("so2", "2026-10-25"), null, "a plan first submitted before the rollout has no new policy");
  at("2026-10-26", "11:00:00");
  assert.equal(await code(svc.requestLateReport(SO2, { workDate: "2026-10-25", reason: REASON })), 422, "no late permission exists for a pre-rollout report");
  assert.equal((await draftComplete(SO2, "2026-10-25")).count > 0, true, "the previous noon rule still applies to it");
  at("2026-10-26", "12:00:01");
  assert.equal(await code(submit(SO2, "2026-10-25")), 422);
  at("2026-10-27", "10:00:00");
  await plan(SO2, "2026-10-27", "C"); // a missed pre-rollout report never blocks (previous behaviour)

  /* ---- 7. audited production gap: one post-rollout Recovery plan missing its policy ---- */
  const SURESH = ctx("suresh", Role.SALES_OFFICER);
  await prisma.user.create({ data: { id: SURESH.userId, username: "so_suresh", name: "Suresh Verma", role: Role.SALES_OFFICER, groupId: "g1", passwordHash: "x" } });
  await prisma.dealer.create({ data: { id: "S", name: "Suresh Recovery Dealer" } });
  await prisma.dealerAssignment.create({ data: { dealerId: "S", officerId: SURESH.userId, effectiveFrom: new Date("2024-01-01") } });
  await prisma.$executeRaw`UPDATE "DailyReportRollout" SET "effectiveAt" = ${new Date("2026-10-19T10:49:19.771Z")} WHERE "id" = 'SO_MIDNIGHT'`;
  at("2026-10-22", "10:38:26.380");
  await svc.saveDailyWork(SURESH, { section: "RECOVERY", workDate: "2026-10-22", rows: [{ dealerId: "S", todaysPlan: 500, entryType: "REGULAR" }] });
  await noPlan(SURESH, "2026-10-22", ["SALES", ...ALL]);
  await svc.submitDailyWorkDay(SURESH, { workDate: "2026-10-22" });
  // Reproduce only the audited missing metadata, not any deleted plan or report.
  await prisma.dailyReportPolicy.deleteMany({ where: { officerId: SURESH.userId } });
  await prisma.dailyWorkEntry.updateMany({ where: { officerId: SURESH.userId, planSubmittedAt: { not: null } }, data: { planSubmittedAt: new Date("2026-10-22T05:08:26.380Z") } });
  at("2026-10-23", "11:29:00");
  const broken = await svc.getDailyStatus(SURESH, "2026-10-23");
  same([broken.previousReport.state, broken.outstandingReport], ["PENDING", null], "the missing policy reproduces the blocked-plan/no-request screenshot");
  const beforePolicies = await prisma.dailyReportPolicy.findMany({ orderBy: { id: "asc" } });
  const beforeEntries = await prisma.dailyWorkEntry.findMany({ where: { officerId: SURESH.userId }, orderBy: { id: "asc" } });
  const beforeDay = await prisma.dailyWorkDay.findMany({ where: { officerId: SURESH.userId } });
  const repair = readFileSync("prisma/migrations/20261029000000_repair_suresh_report_policy/migration.sql", "utf8");
  assert.equal(await prisma.$executeRawUnsafe(repair), 1, "restore only the confirmed missing policy");
  assert.equal(await prisma.$executeRawUnsafe(repair), 0, "rerunning the repair is harmless");
  same(await prisma.dailyReportPolicy.findMany({ where: { officerId: { not: SURESH.userId } }, orderBy: { id: "asc" } }), beforePolicies, "existing policies, including legacy/RM absences, are preserved");
  same(await prisma.dailyWorkEntry.findMany({ where: { officerId: SURESH.userId }, orderBy: { id: "asc" } }), beforeEntries, "all saved planning/report values are preserved");
  same(await prisma.dailyWorkDay.findMany({ where: { officerId: SURESH.userId } }), beforeDay, "the repair does not finalize or unlock the report");
  const fixed = await svc.getDailyStatus(SURESH, "2026-10-23");
  same([fixed.outstandingReport?.date, fixed.outstandingReport?.canRequest, fixed.canSubmit], ["2026-10-22", true, false]);
  assert.equal(ist(fixed.outstandingReport!.deadline), "2026-10-23 00:00:00");
  assert.equal((await rowsReport(SURESH, "2026-10-22")).length, 0, "Sales is empty because the plan is Recovery only");
  const late = await req(SURESH, "2026-10-22", REASON);
  const recovery = (await svc.getDailyWork(SURESH, "RECOVERY", "2026-10-22", undefined, "REPORT")).dealers[0]!;
  assert.equal(await code(post(SURESH, "RECOVERY", "2026-10-22", recovery, { outcome: "COMPLETED", actualAmount: 500 })), 422, "a pending request does not reopen reporting");
  await decide(ADMIN, late.id, { action: "approve" });
  await post(SURESH, "RECOVERY", "2026-10-22", recovery, { outcome: "COMPLETED", actualAmount: 500 });
  await submit(SURESH, "2026-10-22");
  assert.equal((await svc.getDailyStatus(SURESH, "2026-10-23")).outstandingReport, null, "submission after approval clears the next-plan block");
  assert.equal((await prisma.lateReportRequest.findUniqueOrThrow({ where: { id: late.id } })).status, "COMPLETED");
  console.log("report-policy.integration.ts — all scenarios passed");
}
const myLate = (c: AuthContext, date: string) => svc.getDailyStatus(c, date).then((s) => s.lateRequests);
main().then(async () => { await prisma.$disconnect(); }, async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
