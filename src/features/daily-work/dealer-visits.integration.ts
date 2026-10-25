/**
 * Dealer-based Dealer Visits against a REAL, disposable PostgreSQL database: Relationship visits (compulsory purpose), the Visit / Telephonic follow-up of Sales and Recovery,
 * one row per dealer with every source, independent removal of each source, SO / RM dealer scope (forged ids), duplicate prevention, multiple planning batches, No Plan consistency and legacy data.
 *
 *   BILLING_TASK_TEST_URL=postgresql://localhost:5432/billing_task_test npm run test:dealer-visits:db
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

const eq = (actual: unknown, expected: unknown, message?: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const ctx = (userId: string, role: Role, groupId: string | null = "g1", permissions?: Record<string, string[]>): AuthContext => ({ userId, username: userId, role, groupId, permissions }) as AuthContext;
const day = (n: number) => new Date(Date.parse(`${BASE}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const batch = (officer: string, date: string) => `draft:${officer}:${date}`;


const dateOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const setClock = (d: string) => { clock = d; realDailyWork.dailyWorkClock.now = () => new Date(`${d}T05:00:00Z`); }; // 10:30 IST: inside every report window
const noPlan = async (c: AuthContext, date: string, sections: string[]) => { for (const section of sections) await svc.setDailyNoPlan(c, { workDate: date, section, noPlan: true }); };
const rowOf = async (c: AuthContext, section: "SALES" | "RECOVERY", date: string, dealerId: string) => (await svc.getDailyWork(c, section, date, undefined, "REPORT")).dealers.find((d) => d.dealerId === dealerId)!;
const unitOf = (r: { tasks?: { unitType: string; unitId: string }[] }) => r.tasks![0]!;
const post = (c: AuthContext, section: "SALES" | "RECOVERY", date: string, r: { entryId: string; tasks?: { unitType: string; unitId: string }[] }, f: Record<string, unknown>) =>
  svc.enterTaskOutcomes(c, { section, workDate: date, entries: [{ entryId: r.entryId, ...(section === "RECOVERY" && f.outcome === "COMPLETED" ? { paymentMode: "CASH" } : {}), units: [{ unitType: unitOf(r).unitType, unitId: unitOf(r).unitId, ...f }] }] });
const counts = async () => ({
  outcomes: await prisma.dailyTaskOutcome.count(), committed: await prisma.dailyTaskOutcome.count({ where: { state: "COMMITTED" } }), calendar: await prisma.calendarEntry.count(),
  events: await prisma.taskRescheduleEvent.count(), receipts: await prisma.dealerPaymentReceipt.count(), exceptions: await prisma.billingException.count(), tasks: await prisma.billingExceptionTask.count(),
});
const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "CalendarEntry","RecoveryPlanDealer","RecoveryPlan","SeasonMonth","Season","DailyTaskOutcome","DailyWorkEntry","DailyWorkDay","DealerAssignment","Dealer","AuditLog","Notification","TaskRescheduleEvent","User","UserGroup" CASCADE`);
  await prisma.userGroup.createMany({ data: [{ id: "g1", name: "MP" }, { id: "g2", name: "UP" }] });
  const mkUser = (id: string, name: string, role: Role, groupId: string | null) => prisma.user.create({ data: { id, name, username: id, passwordHash: "x", role, groupId } as never });
  await mkUser("rm", "Rita RM", Role.REGIONAL_MANAGER, "g1"); await mkUser("so1", "Bina", Role.SALES_OFFICER, "g1"); await mkUser("so2", "Anil", Role.SALES_OFFICER, "g1"); await mkUser("so4", "Dev Other Group", Role.SALES_OFFICER, "g2");
  for (const [id, name] of [["A", "Alpha"], ["A2", "Alpha Two"], ["A3", "Alpha Three"], ["A4", "Alpha Four"], ["B", "Beta"], ["R", "Rita Own"], ["X", "Xray Other"]] as const) await prisma.dealer.create({ data: { id, name } });
  const assign = (dealerId: string, officerId: string) => prisma.dealerAssignment.create({ data: { dealerId, officerId, effectiveFrom: new Date("2024-01-01") } });
  for (const d of ["A", "A2", "A3", "A4"]) await assign(d, "so1"); await assign("B", "so2"); await assign("R", "rm"); await assign("X", "so4");
  const RM = ctx("rm", Role.REGIONAL_MANAGER, "g1"), SO1 = ctx("so1", Role.SALES_OFFICER), SO2 = ctx("so2", Role.SALES_OFFICER);
  const D = day(0);
  setClock(D);

  const sales = (c: AuthContext, rows: Record<string, unknown>[], date = D) => svc.saveDailyWork(c, { section: "SALES", workDate: date, rows });
  const recovery = (c: AuthContext, rows: Record<string, unknown>[], date = D) => svc.saveDailyWork(c, { section: "RECOVERY", workDate: date, rows });
  const rel = (c: AuthContext, rows: Record<string, unknown>[], date = D) => svc.saveRelationshipVisits(c, { workDate: date, rows });
  const row = (dealerId: string, followUpType?: string, extra: Record<string, unknown> = {}) => ({ dealerId, todaysPlan: 100, entryType: "REGULAR", ...(followUpType ? { followUpType } : {}), ...extra });
  const summary = (c: AuthContext, date = D) => svc.getDailySummary(c, date, undefined, "PLAN");
  const table = async (c: AuthContext) => (await summary(c)).visitRows.map((v) => [v.dealerId, v.sources.join("+"), v.purpose, v.alreadyPlanned]);
  const planned = async (c: AuthContext) => (await summary(c)).dealerVisits;
  const summaryRow = (officer: string, date = D) => prisma.dailyWorkEntry.findFirst({ where: { officerId: officer, section: "SUMMARY", workDate: new Date(`${date}T00:00:00Z`), status: "DRAFT" } });

  /* ---- Sales / Recovery: Follow-up Type is required for a NEW manual entry ---- */
  assert.equal(await code(sales(SO1, [row("A")])), 422, "a new Sales entry without a Follow-up Type is refused");
  assert.notEqual(await code(sales(SO1, [row("A", "PHONE")])), 0, "an unknown Follow-up Type is refused");
  eq(await prisma.dailyWorkEntry.count(), 0, "refused saves wrote nothing");
  await sales(SO1, [row("A", "TELEPHONIC")]);
  eq([await table(SO1), await planned(SO1)], [[], 0], "Telephonic creates no Dealer Visits link");
  assert.equal((await summary(SO1)).visitsEntered, false, "…and does not mark Visits as entered");

  /* ---- Sales Visit / Recovery Visit: one row per dealer with every source ---- */
  await sales(SO1, [row("A", "VISIT")]);
  eq([await table(SO1), await planned(SO1)], [[["A", "SALES", null, false]], 1], "a Sales Visit → one row, Sales");
  await recovery(SO1, [row("A", "VISIT")]);
  eq([await table(SO1), await planned(SO1)], [[["A", "SALES+RECOVERY", null, false]], 1], "Sales and Recovery for one dealer → ONE row, Sales + Recovery, counted once");
  assert.equal((await summary(SO1)).visitsEntered, true);
  // an edit omitting the type keeps the stored one (autosave of an unchanged row)
  await sales(SO1, [{ dealerId: "A", todaysPlan: 150, entryType: "REGULAR" }]);
  eq(await table(SO1), [["A", "SALES+RECOVERY", null, false]], "an update that omits the Follow-up Type keeps it");

  /* ---- Relationship visits: compulsory purpose, scope, duplicates ---- */
  for (const purpose of ["", "   ", "\n\t "]) assert.notEqual(await code(rel(SO1, [{ dealerId: "A2", purpose }])), 0, `blank purpose ${JSON.stringify(purpose)} is refused`);
  assert.notEqual(await code(rel(SO1, [{ dealerId: "A2" }])), 0, "a missing purpose is refused");
  assert.equal(await code(rel(SO1, [{ dealerId: "A", purpose: "Courtesy" }])), 409, "a dealer already in Dealer Visits (Sales / Recovery) cannot be added again");
  assert.equal(await code(rel(SO1, [{ dealerId: "A2", purpose: "x" }, { dealerId: "A2", purpose: "y" }])), 422, "duplicate dealers in one request are refused");
  assert.equal(await code(rel(SO1, [{ dealerId: "B", purpose: "Courtesy" }])), 403, "another officer's dealer is out of scope");
  assert.equal(await code(rel(SO1, [{ dealerId: "A2", purpose: "Courtesy", ownerId: "so2" }])), 403, "a forged owner id is refused");
  assert.equal(await code(rel(SO1, [{ dealerId: "X", purpose: "Courtesy" }])), 403, "another group's dealer is refused");
  eq(await prisma.dailyWorkEntry.count({ where: { section: "RELATIONSHIP" } }), 0, "refused requests created no visit");
  await rel(SO1, [{ dealerId: "A2", purpose: "  Discuss display stock  " }]);
  eq([await table(SO1), await planned(SO1)], [[["A", "SALES+RECOVERY", null, false], ["A2", "RELATIONSHIP", "Discuss display stock", false]], 2], "a Relationship visit is added with its trimmed purpose; the total is the number of unique dealer rows");
  await rel(SO1, [{ dealerId: "A2", purpose: "Discuss display stock" }]); await rel(SO1, [{ dealerId: "A2", purpose: "Discuss display stock" }]);
  eq(await prisma.dailyWorkEntry.count({ where: { section: "RELATIONSHIP" } }), 1, "a repeated request never duplicates the visit");
  eq((await svc.getDailySummary(SO1, D, undefined, "PLAN")).dealerVisits, 2, "…nor the count (reload)");

  /* ---- Relationship first, then a Sales Visit: one row keeps its purpose ---- */
  await rel(SO1, [{ dealerId: "A2", purpose: "Discuss display stock" }, { dealerId: "A3", purpose: "Introduce new scheme" }]);
  await sales(SO1, [row("A", "VISIT"), row("A3", "VISIT")]);
  eq([await table(SO1), await planned(SO1)], [[["A", "SALES+RECOVERY", null, false], ["A3", "RELATIONSHIP+SALES", "Introduce new scheme", false], ["A2", "RELATIONSHIP", "Discuss display stock", false]], 3], "Relationship + Sales on one dealer: one row, purpose kept");
  assert.equal(await code(rel(SO1, [{ dealerId: "A2", purpose: "Discuss display stock" }, { dealerId: "A3", purpose: "Introduce new scheme" }, { dealerId: "A", purpose: "again" }])), 409, "a source-linked dealer cannot be added as Relationship (server-side)");

  /* ---- independent removal / change of each source ---- */
  await sales(SO1, [row("A", "TELEPHONIC"), row("A3", "VISIT")]);
  eq(await table(SO1), [["A", "RECOVERY", null, false], ["A3", "RELATIONSHIP+SALES", "Introduce new scheme", false], ["A2", "RELATIONSHIP", "Discuss display stock", false]], "Sales Visit → Telephonic removes only the Sales link; Recovery keeps the row");
  await rel(SO1, [{ dealerId: "A2", purpose: "Discuss display stock" }]); // the Relationship component of A3 removed while its Sales Visit stays
  eq(await table(SO1), [["A", "RECOVERY", null, false], ["A3", "SALES", null, false], ["A2", "RELATIONSHIP", "Discuss display stock", false]], "removing a Relationship component never deletes the surviving Sales link");
  await recovery(SO1, []);
  eq([await table(SO1), await planned(SO1)], [[["A3", "SALES", null, false], ["A2", "RELATIONSHIP", "Discuss display stock", false]], 2], "removing the Recovery entry removes the last source of A: the row disappears");
  await sales(SO1, []);
  eq([await table(SO1), await planned(SO1)], [[["A2", "RELATIONSHIP", "Discuss display stock", false]], 1], "removing the Sales entry removes its link");
  await rel(SO1, []);
  eq([await table(SO1), await planned(SO1)], [[], 0], "no sources → no rows and the count returns to 0");
  assert.equal((await summary(SO1)).visitsEntered, false, "…and Visits is not 'entered' any more");

  /* ---- No Plan consistency ---- */
  await svc.setDailyNoPlan(SO1, { workDate: D, section: "VISITS", noPlan: true });
  await sales(SO1, [row("A", "VISIT")]);
  assert.equal((await svc.getDailyStatus(SO1, D)).sections.find((s) => s.section === "VISITS")!.status !== "NO_PLAN", true, "a linked Visit clears a stale Visits 'No Plan'");
  assert.equal(await code(svc.setDailyNoPlan(SO1, { workDate: D, section: "VISITS", noPlan: true })), 409, "No Plan cannot be set while real visit entries exist");
  await sales(SO1, []);

  /* ---- Regional Manager: own + authorized officers' dealers; the entry stays the RM's ---- */
  const choices = await svc.getDealerChoices(RM, "VISITS");
  eq([choices.owners.map((o) => o.name), choices.ownerId, choices.dealers.map((d) => d.id)], [["Anil", "Bina"], "rm", ["R"]], "My Dealers by default; the officer filter lists the group's active officers");
  eq((await svc.getDealerChoices(RM, "VISITS", "so1")).dealers.map((d) => d.id), ["A", "A4", "A3", "A2"], "an authorized officer's dealers");
  for (const forged of ["so4", "rm2", "admin", "nope"]) assert.equal(await code(svc.getDealerChoices(RM, "VISITS", forged)), 403, `forged owner ${forged}`);
  assert.equal(await code(svc.getDealerChoices(SO1, "VISITS", "so2")), 403, "an SO cannot browse another officer's dealers");
  assert.equal(await code(rel(RM, [{ dealerId: "A", purpose: "x", ownerId: "so2" }])), 403, "mismatched dealer / owner pair");
  assert.equal(await code(rel(RM, [{ dealerId: "X", purpose: "x" }])), 403, "another group's dealer");
  assert.equal(await code(rel(RM, [{ dealerId: "A", purpose: "x", ownerId: "so4" }])), 403, "forged owner id");
  await rel(RM, [{ dealerId: "A", purpose: "Review with Bina's dealer", ownerId: "so1" }, { dealerId: "R", purpose: "Own dealer" }]);
  eq((await prisma.dailyWorkEntry.findMany({ where: { section: "RELATIONSHIP" }, orderBy: { dealerId: "asc" } })).map((r) => [r.officerId, r.dealerId]), [["rm", "A"], ["rm", "R"]], "the visit is the RM's own Daily Work entry");
  eq(await prisma.dailyWorkEntry.count({ where: { officerId: { in: ["so1", "so2"] }, section: "RELATIONSHIP" } }), 0, "nothing is created for the Sales Officers");
  eq((await svc.getDealerChoices(RM, "VISITS", "so1")).dealers.map((d) => d.id), ["A4", "A3", "A2"], "a dealer already in Dealer Visits is excluded from the dialog");
  await svc.saveDailyWork(RM, { section: "RECOVERY", workDate: D, rows: [row("A", "VISIT", { ownerId: "so1" })] });
  eq((await summary(RM)).visitRows.map((v) => [v.dealerId, v.sources.join("+")]), [["A", "RELATIONSHIP+RECOVERY"], ["R", "RELATIONSHIP"]], "an RM's Recovery Visit for an SO's dealer links to the same one row");
  assert.equal((await summary(RM)).canPickDealerOwner, true);
  assert.equal((await summary(SO1)).canPickDealerOwner, false);

  /* ---- legacy data: untouched numeric plans, task rows and older rows get no invented follow-up ---- */
  const L1 = day(-3);
  await prisma.dailyWorkEntry.create({ data: { officerId: "so2", workDate: new Date(`${L1}T00:00:00Z`), batchId: "legacy-batch", section: "SUMMARY", rowKey: "SUMMARY", dealerVisits: 5, newPartyVisits: 2, status: "PLAN_SUBMITTED", planSubmittedAt: new Date() } as never });
  const legacy = await svc.getDailySummary(SO2, L1, undefined, "REPORT");
  eq([legacy.dealerVisits, legacy.newPartyVisits, legacy.visitRows], [5, 2, []], "a legacy submitted numeric plan is shown exactly as stored, with no invented dealer rows");
  setClock(D);
  await prisma.dailyWorkEntry.create({ data: { officerId: "so2", dealerId: "B", workDate: new Date(`${D}T00:00:00Z`), batchId: batch("so2", D), section: "SALES", rowKey: "B", todaysPlan: 10, entryType: "REGULAR", status: "DRAFT" } as never });
  await prisma.dailyWorkEntry.create({ data: { officerId: "so2", workDate: new Date(`${D}T00:00:00Z`), batchId: batch("so2", D), section: "SUMMARY", rowKey: "SUMMARY", dealerVisits: 3, newPartyVisits: null, status: "DRAFT" } as never });
  const legacyDraft = await svc.getDailyWork(SO2, "SALES", D, undefined, "PLAN");
  eq(legacyDraft.dealers.map((d) => [d.dealerId, d.followUpType]), [["B", null]], "an older draft entry shows no Follow-up Type (nothing invented)");
  await svc.saveDailyWork(SO2, { section: "SALES", workDate: D, rows: [{ dealerId: "B", todaysPlan: 20, entryType: "REGULAR" }] });
  eq([(await summaryRow("so2"))!.dealerVisits, (await prisma.dailyWorkEntry.findFirst({ where: { officerId: "so2", section: "SALES" } }))!.followUpType], [3, null], "saving the older draft keeps its numeric plan and leaves the Follow-up Type empty");
  await svc.saveDailySummary(SO2, { workDate: D, focus: "VISITS", newPartyVisits: 4 });
  eq([(await summaryRow("so2"))!.dealerVisits, (await summaryRow("so2"))!.newPartyVisits], [3, 4], "New Party Visits is saved as before and the legacy Dealer Visits number is untouched");
  await prisma.dailyWorkEntry.deleteMany({ where: { officerId: "so2" } });

  /* ---- Calendar Daily Tasks for Visits keep adding their visit count to the planned total ---- */
  await prisma.calendarEntry.create({ data: { ownerId: "so2", kind: "TASK", date: new Date(`${D}T00:00:00Z`), taskSection: "VISITS", dealerVisits: 2, newPartyVisits: 1 } as never });
  eq((await summary(SO2)).dealerVisits, 2, "the Calendar task's visit count lands in the planned total as before");
  await svc.saveDailyWork(SO2, { section: "SALES", workDate: D, rows: [row("B", "VISIT")] });
  eq([(await summary(SO2)).dealerVisits, (await summary(SO2)).visitRows.length], [3, 1], "Calendar count + the derived dealer rows");
  await svc.saveDailyWork(SO2, { section: "SALES", workDate: D, rows: [] });
  eq((await summary(SO2)).dealerVisits, 2, "removing the last dealer source leaves the Calendar count in place");
  await prisma.dailyWorkEntry.deleteMany({ where: { officerId: "so2" } }); await prisma.calendarEntry.deleteMany({});

  /* ---- New Party Visits keeps working beside the derived count; the posted Dealer Visits number is ignored ---- */
  await sales(SO1, [row("A", "VISIT")]);
  await svc.saveDailySummary(SO1, { workDate: D, focus: "VISITS", dealerVisits: 99, newPartyVisits: 7 });
  eq([(await summaryRow("so1"))!.dealerVisits, (await summaryRow("so1"))!.newPartyVisits], [1, 7], "a posted Dealer Visits number cannot override the derived count; New Party Visits is stored as entered");
  await svc.saveDailySummary(SO1, { workDate: D, focus: "OTHERS", others: "note" });
  eq((await summaryRow("so1"))!.dealerVisits, 1, "an Others-only save leaves the derived count alone");

  /* ---- submission, report actuals and multiple planning batches ---- */
  await rel(SO1, [{ dealerId: "A2", purpose: "Quarterly review" }]);
  await sales(SO1, [row("A", "VISIT"), row("A4", "TELEPHONIC")]);
  await noPlan(SO1, D, ["RECOVERY", "APPOINTMENT"]);
  await svc.submitDailyWorkDay(SO1, { workDate: D });
  const first = await prisma.dailyWorkEntry.findFirstOrThrow({ where: { officerId: "so1", section: "SUMMARY", status: "PLAN_SUBMITTED" } });
  eq([first.dealerVisits, first.newPartyVisits, first.actualDealerVisits], [2, 7, null], "the submitted batch stores the derived planned count; no actual is inferred");
  eq((await prisma.dailyWorkEntry.findMany({ where: { officerId: "so1", section: "RELATIONSHIP" } })).map((r) => [r.status, r.purpose]), [["PLAN_SUBMITTED", "Quarterly review"]], "the Relationship visit is frozen with its batch");
  // second batch: a dealer already planned in the first batch is not counted (or addable) again
  eq((await svc.getDealerChoices(SO1, "VISITS")).dealers.map((d) => d.id), ["A4", "A3"], "dealers already planned in an earlier batch are excluded from the dialog");
  assert.equal(await code(rel(SO1, [{ dealerId: "A2", purpose: "Again" }])), 409, "…and refused by the server");
  await recovery(SO1, [row("A", "VISIT")]); await sales(SO1, [row("A3", "VISIT")]); // A's Sales slot is used by the first batch (existing one-manual-task rule)
  eq([await table(SO1), await planned(SO1)], [[["A", "RECOVERY", null, true], ["A3", "SALES", null, false]], 1], "multiple batches: a dealer is never counted twice in the day's planned Dealer Visits");
  eq((await prisma.dailyWorkEntry.findFirstOrThrow({ where: { id: first.id } })).dealerVisits, 2, "the submitted batch's stored count is unchanged");
  eq(await code(svc.saveRelationshipVisits(SO2, { workDate: D, rows: [{ dealerId: "A2", purpose: "x" }] })), 403, "another officer cannot write to this dealer");
  // Dealer results save progressively; the total is derived and numeric-only clients cannot bypass them.
  const report = () => svc.getDailySummary(SO1, D, undefined, "REPORT");
  const reportComplete = async () => (await svc.getDailyStatus(SO1, D)).reportSections.find((section) => section.section === "VISITS")!.complete;
  const choose = (dealerId: string, result: "VISITED" | "NOT_VISITED" | null) => ({ dealerId, result });
  const send = (entry: Record<string, unknown>) => svc.enterVisitsActual(SO1, { workDate: D, entries: [{ entryId: first.id, ...entry }] });
  const rep = await report();
  eq([rep.dealerVisits, rep.newPartyVisits, rep.actualDealerVisits], [2, 7, null]);
  eq(rep.reportVisitRows.map((visit) => [visit.dealerId, visit.sources, visit.result]), [["A", ["SALES"], null], ["A2", ["RELATIONSHIP"], null]], "all frozen sources appear; a draft dealer is excluded");
  assert.equal(await reportComplete(), false);
  assert.equal(await code(send({ actualDealerVisits: 1, actualNewPartyVisits: 5 })), 422, "a number cannot bypass mandatory choices");
  await send({ actualNewPartyVisits: 5, dealerVisitResults: [choose("A", "VISITED")] });
  eq([(await report()).actualDealerVisits, (await report()).reportVisitRows.map((visit) => visit.result)], [null, ["VISITED", null]], "partial choices survive reload without inventing the unanswered result");
  assert.equal(await reportComplete(), false);
  for (const id of ["A3", "A4", "X", "nope"]) assert.equal(await code(send({ dealerVisitResults: [choose(id, "VISITED")] })), 422, "draft, telephonic and foreign dealers cannot be reported as planned visits");
  assert.equal(await code(send({ dealerVisitResults: [choose("A", "VISITED"), choose("A", "NOT_VISITED")] })), 422, "duplicate choices rejected");
  assert.equal(await code(svc.enterVisitsActual(SO2, { workDate: D, entries: [{ entryId: first.id, dealerVisitResults: [choose("A", "VISITED")] }] })), 409, "another officer cannot change these results");
  const beforeBad = JSON.stringify(await prisma.dailyWorkEntry.findUnique({ where: { id: first.id } }));
  assert.equal(await code(svc.enterVisitsActual(SO1, { workDate: D, entries: [{ entryId: first.id, dealerVisitResults: [choose("A2", "VISITED")] }, { entryId: "forged", actualNewPartyVisits: 0 }] })), 409);
  assert.equal(JSON.stringify(await prisma.dailyWorkEntry.findUnique({ where: { id: first.id } })), beforeBad, "a bad batch rolls back the complete request");
  await send({ dealerVisitResults: [choose("A2", "NOT_VISITED")] });
  eq([(await report()).actualDealerVisits, (await report()).actualNewPartyVisits, await reportComplete()], [1, 5, true], "Visited counts once; Not Visited counts zero and satisfies the mandatory response");
  await send({ dealerVisitResults: [choose("A2", null)] });
  eq([(await report()).actualDealerVisits, await reportComplete()], [null, false], "clearing a result makes Visits incomplete again");
  await send({ dealerVisitResults: [choose("A", "NOT_VISITED"), choose("A2", "NOT_VISITED")] });
  eq([(await report()).actualDealerVisits, await reportComplete()], [0, true], "explicit zero is a completed report, not a missing result");

  // Submit a second batch: A's Recovery source merges into its original visit and retains the earlier answer.
  await noPlan(SO1, D, ["APPOINTMENT", "OTHERS"]);
  await svc.submitDailyWorkDay(SO1, { workDate: D });
  const two = await report();
  eq(two.reportVisitRows.map((visit) => [visit.dealerId, visit.sources, visit.result]), [["A", ["SALES", "RECOVERY"], "NOT_VISITED"], ["A3", ["SALES"], null], ["A2", ["RELATIONSHIP"], "NOT_VISITED"]], "one dealer/day across batches with merged sources and preserved result");
  const thirdVisit = two.reportVisitRows.find((visit) => visit.dealerId === "A3")!;
  assert.equal(await code(send({ dealerVisitResults: [choose("A3", "VISITED")] })), 422, "a dealer must be answered on its owning summary batch");
  await svc.enterVisitsActual(SO1, { workDate: D, entries: [{ entryId: thirdVisit.entryId, actualNewPartyVisits: 0, dealerVisitResults: [choose("A3", "VISITED")] }] });
  eq([(await report()).actualDealerVisits, await reportComplete()], [1, true], "no double count across batches");

  // SO full submit: unanswered visits block finalization, even if a forged old total exists.
  const reportSales = await svc.getDailyWork(SO1, "SALES", D, undefined, "REPORT");
  const reportRecovery = await svc.getDailyWork(SO1, "RECOVERY", D, undefined, "REPORT");
  for (const visit of reportSales.dealers) await post(SO1, "SALES", D, visit, { outcome: "COMPLETED", actualAmount: 1 });
  for (const visit of reportRecovery.dealers) await post(SO1, "RECOVERY", D, visit, { outcome: "COMPLETED", actualAmount: 1 });
  await prisma.dailyWorkEntry.update({ where: { id: first.id }, data: { dealerVisitResults: { results: { A: "NOT_VISITED" }, additionalDealerVisits: 0 }, actualDealerVisits: 0 } });
  assert.equal(await code(svc.submitDailyReport(SO1, { workDate: D, selfRating: 7 })), 422, "final submit checks every result, not just the numeric total");
  await send({ dealerVisitResults: [choose("A2", "NOT_VISITED")] });
  await svc.submitDailyReport(SO1, { workDate: D, selfRating: 7 });
  assert.equal(await code(send({ dealerVisitResults: [choose("A", "VISITED")] })), 409, "finalized results are locked");
  eq((await report()).reportVisitRows.find((visit) => visit.dealerId === "A3")!.result, "VISITED", "final results remain readable");

  // RM uses the same mandatory per-dealer flow, including authorized officers' dealers.
  await noPlan(RM, D, ["SALES", "APPOINTMENT", "OTHERS"]);
  await svc.submitDailyWorkDay(RM, { workDate: D });
  const rmReport = await svc.getDailySummary(RM, D, undefined, "REPORT");
  for (const visit of (await svc.getDailyWork(RM, "RECOVERY", D, undefined, "REPORT")).dealers) await post(RM, "RECOVERY", D, visit, { outcome: "COMPLETED", actualAmount: 1 });
  assert.equal(await code(svc.submitDailyReport(RM, { workDate: D, selfRating: 7 })), 422);
  await svc.enterVisitsActual(RM, { workDate: D, entries: rmReport.batches.map((entry) => ({ entryId: entry.entryId, actualNewPartyVisits: 0, dealerVisitResults: rmReport.reportVisitRows.filter((visit) => visit.entryId === entry.entryId).map((visit) => choose(visit.dealerId, "VISITED")) })) });
  await svc.submitDailyReport(RM, { workDate: D, selfRating: 8 });
  eq((await svc.getDailySummary(RM, D, undefined, "REPORT")).actualDealerVisits, rmReport.reportVisitRows.length, "RM actual visits derive from the individual choices");

  // Old numeric-only plans have no identifiable dealer rows; their actual-count workflow remains available.
  await svc.saveDailySummary(SO2, { workDate: D, focus: "VISITS", dealerVisits: 3, newPartyVisits: 2 });
  await noPlan(SO2, D, ["SALES", "RECOVERY", "APPOINTMENT", "OTHERS"]);
  await svc.submitDailyWorkDay(SO2, { workDate: D });
  const oldReport = await svc.getDailySummary(SO2, D, undefined, "REPORT");
  eq(oldReport.reportVisitRows, []);
  await svc.enterVisitsActual(SO2, { workDate: D, entries: [{ entryId: oldReport.batches[0].entryId, actualDealerVisits: 2, actualNewPartyVisits: 1 }] });
  eq((await svc.getDailySummary(SO2, D, undefined, "REPORT")).actualDealerVisits, 2);
  // A count-only Calendar visit can coexist with dealer choices; partial saves must retain its separate actual.
  await svc.submitDailyReport(SO2, { workDate: D, selfRating: 7 });
  const M = day(1); setClock(M);
  await prisma.calendarEntry.create({ data: { ownerId: "so2", kind: "TASK", date: new Date(`${M}T00:00:00Z`), taskSection: "VISITS", dealerVisits: 2, newPartyVisits: 1 } as never });
  await summary(SO2, M);
  await sales(SO2, [row("B", "VISIT")], M);
  await noPlan(SO2, M, ["RECOVERY", "APPOINTMENT", "OTHERS"]);
  await svc.submitDailyWorkDay(SO2, { workDate: M });
  const mixedReport = () => svc.getDailySummary(SO2, M, undefined, "REPORT");
  const mixed = await mixedReport();
  eq([mixed.dealerVisits, mixed.reportVisitRows.length], [3, 1]);
  const mixedId = mixed.batches[0].entryId;
  await svc.enterVisitsActual(SO2, { workDate: M, entries: [{ entryId: mixedId, additionalDealerVisits: 1, actualNewPartyVisits: 2 }] });
  eq([(await mixedReport()).actualDealerVisits, (await mixedReport()).batches[0].additionalActualDealerVisits], [null, 1], "unanswered dealer stays incomplete while the separately entered count survives reload");
  await svc.enterVisitsActual(SO2, { workDate: M, entries: [{ entryId: mixedId, dealerVisitResults: [choose("B", "VISITED")] }] });
  eq([(await mixedReport()).actualDealerVisits, (await mixedReport()).actualNewPartyVisits], [2, 2], "one Visited dealer plus the other visit actual, with New Party Visits unchanged");
  await recovery(SO2, [row("B", "VISIT")], M);
  await noPlan(SO2, M, ["SALES", "APPOINTMENT", "OTHERS"]);
  await svc.submitDailyWorkDay(SO2, { workDate: M });
  const duplicateBatch = (await mixedReport()).batches.find((entry) => entry.dealerVisitsDerived && entry.dealerVisits === 0)!;
  assert.ok(duplicateBatch, "a batch with only an already planned dealer contributes zero new visits");
  assert.equal(await code(svc.enterVisitsActual(SO2, { workDate: M, entries: [{ entryId: duplicateBatch.entryId, actualDealerVisits: 1, actualNewPartyVisits: 0 }] })), 422);
  await svc.enterVisitsActual(SO2, { workDate: M, entries: [{ entryId: duplicateBatch.entryId, actualNewPartyVisits: 0 }] });
  eq((await mixedReport()).actualDealerVisits, 2, "an already counted dealer cannot be added again through a batch total");
  console.log("dealer-visits.integration.ts — all scenarios passed");
}
main().then(async () => { await prisma.$disconnect(); }, async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
