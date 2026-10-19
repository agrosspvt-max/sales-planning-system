/**
 * Regional Manager dealer selection against a REAL, disposable PostgreSQL database: the Sales Officer filter of Add Dealer (My Dealers by default; one authorized officer at a time), forged
 * owner ids, current-owner resolution, server-side manual-entry eligibility, the RM's own ownership of the task, sourced figures of the officer's dealer, and the duplicate rules.
 *
 *   BILLING_TASK_TEST_URL=postgresql://localhost:5432/billing_task_test npm run test:dealer-owner:db
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
const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "CalendarEntry","RecoveryPlanDealer","RecoveryPlan","SeasonMonth","Season","DailyTaskOutcome","DailyWorkEntry","DailyWorkDay","DealerAssignment","Dealer","AuditLog","Notification","TaskRescheduleEvent","User","UserGroup" CASCADE`);
  await prisma.userGroup.createMany({ data: [{ id: "g1", name: "MP" }, { id: "g2", name: "UP" }] });
  const mkUser = (id: string, name: string, role: Role, groupId: string | null, extra: Record<string, unknown> = {}) => prisma.user.create({ data: { id, name, username: id, passwordHash: "x", role, groupId, ...extra } as never });
  await mkUser("rm", "Rita RM", Role.REGIONAL_MANAGER, "g1"); await mkUser("so1", "Bina", Role.SALES_OFFICER, "g1"); await mkUser("so2", "Anil", Role.SALES_OFFICER, "g1");
  await mkUser("so3", "Chandra Inactive", Role.SALES_OFFICER, "g1", { isActive: false }); await mkUser("rm2", "Other RM", Role.REGIONAL_MANAGER, "g2"); await mkUser("so4", "Dev Other Group", Role.SALES_OFFICER, "g2");
  for (const [id, name] of [["R", "Rita Own"], ["A", "Alpha"], ["B", "Beta"], ["C", "Gamma Inactive"], ["X", "Xray Other"], ["L", "Lima Twice"], ["Z", "Zulu Unassigned"]] as const) await prisma.dealer.create({ data: { id, name } });
  const assign = (dealerId: string, officerId: string, from: string) => prisma.dealerAssignment.create({ data: { dealerId, officerId, effectiveFrom: new Date(from) } });
  await assign("R", "rm", "2024-01-01"); await assign("A", "so1", "2024-01-01"); await assign("B", "so2", "2024-01-01"); await assign("C", "so3", "2024-01-01"); await assign("X", "so4", "2024-01-01");
  await assign("L", "so1", "2023-01-01"); await assign("L", "so2", "2025-01-01"); // an older open assignment that was never closed: L currently belongs to so2 only
  const RM = ctx("rm", Role.REGIONAL_MANAGER, "g1"), SO1 = ctx("so1", Role.SALES_OFFICER), RM2 = ctx("rm2", Role.REGIONAL_MANAGER, "g2");
  const D = day(0);
  setClock(D);
  const ids = (c: { dealers: { id: string }[] }) => c.dealers.map((d) => d.id);

  /* ---- Sales Officers keep their own-dealer flow ---- */
  const so = await svc.getDealerChoices(SO1, "SALES");
  same([so.owners, so.ownerId, ids(so)], [[], "so1", ["A"]], "an SO sees only their own current dealers and gets no owner filter");
  assert.equal(await code(svc.getDealerChoices(SO1, "SALES", "so2")), 403, "an SO cannot browse another officer's dealers");
  assert.equal((await svc.getDailyWork(SO1, "SALES", D, undefined, "PLAN")).canPickDealerOwner, false);

  /* ---- the RM: My Dealers by default; one authorized, active officer at a time; alphabetical ---- */
  const mine = await svc.getDealerChoices(RM, "RECOVERY");
  same([mine.owners.map((o) => o.name), mine.ownerId, ids(mine)], [["Anil", "Bina"], "rm", ["R"]], "default = My Dealers; only active officers of the RM's own group, alphabetical; the inactive and other-group officers are absent");
  same(ids(await svc.getDealerChoices(RM, "RECOVERY", "so1")), ["A"], "an officer's name → only that officer's dealers");
  same(ids(await svc.getDealerChoices(RM, "RECOVERY", "so2")), ["B", "L"], "the dealer with an older open assignment belongs to its CURRENT owner only, once");
  same(ids(await svc.getDealerChoices(RM, "RECOVERY", "so1")).includes("L"), false);
  for (const forged of ["so3", "so4", "rm2", "admin", "nope", "so1' OR 1=1"]) assert.equal(await code(svc.getDealerChoices(RM, "RECOVERY", forged)), 403, `forged / out-of-scope owner ${forged}`);
  assert.equal(await code(svc.getDealerChoices(RM2, "RECOVERY", "so1")), 403, "another RM never reaches this group's officers or dealers");
  same(ids(await svc.getDealerChoices(RM2, "RECOVERY", "so4")), ["X"]);
  assert.equal((await svc.getDailyWork(RM, "RECOVERY", D, undefined, "PLAN")).canPickDealerOwner, true);
  // An RM without any officers in scope still has My Dealers.
  await prisma.user.updateMany({ where: { id: { in: ["so1", "so2"] } }, data: { isActive: false } });
  same([(await svc.getDealerChoices(RM, "SALES")).owners, ids(await svc.getDealerChoices(RM, "SALES"))], [[], ["R"]]);
  await prisma.user.updateMany({ where: { id: { in: ["so1", "so2"] } }, data: { isActive: true } });

  /* ---- sourced figures of the officer's dealer come from THAT officer's authoritative source ---- */
  const season = await prisma.season.create({ data: { name: "S", year: 2026 } });
  const month = await prisma.seasonMonth.create({ data: { seasonId: season.id, name: "October", order: 1, calendarMonth: 10, calendarYear: 2026 } });
  const so1Plan = await prisma.recoveryPlan.create({ data: { seasonId: season.id, seasonMonthId: month.id, officerId: "so1", cutoffDate: new Date(D), status: "APPROVED" } as never });
  await prisma.recoveryPlanDealer.create({ data: { recoveryPlanId: so1Plan.id, dealerId: "A", monthRecoveryPlan: 100000, monthRunningRecovery: 20000, liveRecovery: 30000 } });
  const choice = (await svc.getDealerChoices(RM, "RECOVERY", "so1")).dealers[0]!;
  same([choice.monthlyPlan, choice.actual, choice.pending], [120000, 30000, 90000], "Monthly Recovery Plan / Actual / Pending from the officer's own plan, existing formulas");

  /* ---- manual entry: eligibility on the server; the task stays the RM's ---- */
  const save = (c: AuthContext, section: "SALES" | "RECOVERY", rows: Record<string, unknown>[]) => svc.saveDailyWork(c, { section, workDate: D, rows });
  const base = { entryType: "REGULAR" };
  assert.equal(await code(save(RM, "RECOVERY", [{ dealerId: "X", todaysPlan: 10, ...base }])), 403, "another group's dealer is refused");
  assert.equal(await code(save(RM, "RECOVERY", [{ dealerId: "Z", todaysPlan: 10, ...base }])), 403, "an unassigned dealer is refused");
  assert.equal(await code(save(RM, "RECOVERY", [{ dealerId: "C", todaysPlan: 10, ...base }])), 403, "a dealer of an inactive officer is out of scope");
  assert.equal(await code(save(RM, "RECOVERY", [{ dealerId: "A", todaysPlan: 10, ownerId: "so2", ...base }])), 403, "a mismatched dealer / owner pair is refused");
  assert.equal(await code(save(RM, "RECOVERY", [{ dealerId: "A", todaysPlan: 10, ownerId: "so4", ...base }])), 403, "a forged owner id is refused");
  assert.equal(await code(save(SO1, "RECOVERY", [{ dealerId: "B", todaysPlan: 10, ...base }])), 403, "an SO still cannot add another officer's dealer");
  assert.equal(await code(save(RM, "RECOVERY", [{ dealerId: "L", todaysPlan: 10, ownerId: "so1", ...base }])), 403, "the stale older assignment does not make so1 the owner of L");
  eq(await prisma.dailyWorkEntry.count(), 0, "refused saves wrote nothing");
  await save(RM, "RECOVERY", [{ dealerId: "A", todaysPlan: 5000, ownerId: "so1", ...base }, { dealerId: "L", todaysPlan: 700, ownerId: "so2", ...base }, { dealerId: "R", todaysPlan: 300, ...base }]);
  await save(RM, "SALES", [{ dealerId: "A", todaysPlan: 1200, ...base }]); // the same dealer once in Sales too (independent limits)
  const rows = await prisma.dailyWorkEntry.findMany({ where: { section: "RECOVERY" }, orderBy: { dealerId: "asc" } });
  same(rows.map((r) => [r.officerId, r.dealerId, Number(r.todaysPlan)]), [["rm", "A", 5000], ["rm", "L", 700], ["rm", "R", 300]], "the tasks belong to the RM's own Daily Plan (no officer's report is touched)");
  assert.equal(await prisma.dailyWorkEntry.count({ where: { officerId: { in: ["so1", "so2"] } } }), 0, "nothing is created for the Sales Officers");
  same((await prisma.dealerAssignment.findMany({ where: { dealerId: "A", effectiveTo: null } })).map((a) => a.officerId), ["so1"], "the dealer is not reassigned");
  // Reload: the RM's report lists them with the owner's sourced figures; dealer-level figures are not doubled across rows.
  const reload = await svc.getDailyWork(RM, "RECOVERY", D, undefined, "PLAN");
  same(reload.dealers.map((d) => [d.dealerId, d.rowKind, d.monthlyPlan, d.pending]), [["A", "MANUAL", 120000, 90000], ["L", "MANUAL", 0, 0], ["R", "MANUAL", 0, 0]], "RM tasks persist with the officer's Monthly Plan / Pending");
  // Duplicate rules: one directly entered task per dealer / employee / date / section — also against earlier submitted batches — while scheduled tasks never consume the slot.
  await prisma.calendarEntry.create({ data: { ownerId: "rm", kind: "TASK", date: new Date(D), taskSection: "RECOVERY", dealerId: "R", amount: 999, entryType: "REGULAR" } as never });
  await svc.getDailyWork(RM, "RECOVERY", D, undefined, "PLAN");
  same((await prisma.dailyWorkEntry.findMany({ where: { section: "RECOVERY", dealerId: "R" }, orderBy: { rowKey: "asc" } })).map((r) => [r.rowKey, Number(r.todaysPlan)]), [["R", 300], ["t:CAL:" + (await prisma.calendarEntry.findFirstOrThrow()).id, 999]], "a scheduled task is its own row next to the manual one");
  await noPlan(RM, D, ["SALES", "APPOINTMENT", "VISITS", "OTHERS"].filter((x) => x !== "SALES"));
  await svc.submitDailyWorkDay(RM, { workDate: D });
  const after = await svc.getDealerChoices(RM, "RECOVERY", "so1");
  same(ids(after), [], "a dealer with a submitted manual task is no longer offered for that date and section");
  assert.equal(await code(save(RM, "RECOVERY", [{ dealerId: "A", todaysPlan: 1, ownerId: "so1", ...base }])), 409, "a second directly entered task is rejected across batches");
  same(ids(await svc.getDealerChoices(RM, "SALES", "so1")), [], "Sales has its own (sales manual A already added) slot");
  console.log("dealer-owner.integration.ts — all scenarios passed");
}
main().then(async () => { await prisma.$disconnect(); }, async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
