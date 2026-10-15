/**
 * Daily Work → Dealer Appointment ↔ the owner's approved Monthly Party Planning, against a REAL, disposable PostgreSQL database.
 *
 *   createdb appointment_test && DATABASE_URL=postgresql://localhost:5432/appointment_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   APPOINTMENT_TEST_URL=postgresql://localhost:5432/appointment_test npm run test:daily-appointment:db   (the script turns Party Planning on for the run)
 *
 * Only a LOCAL database named `appointment_test` is permitted — the script TRUNCATEs the tables it uses.
 */
import assert from "node:assert/strict";
import { Prisma, PrismaClient, Role } from "@prisma/client";
import * as realDailyWork from "@/lib/daily-work";
import * as realLabels from "@/features/labels/labels";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

const url = process.env.APPOINTMENT_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/appointment_test")
  throw new Error("Only a local database named appointment_test is permitted (set APPOINTMENT_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
const TODAY = "2026-10-14";
realDailyWork.dailyWorkClock.now = () => new Date(`${TODAY}T06:00:00Z`); // 11:30 IST on the Daily Work date
const DEFAULT_LABELS = realLabels.DEFAULT_LABELS as Record<string, string>;
const svc = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => ({}) },
  "@/lib/daily-work": { ...realDailyWork, currentBusinessDate: (d?: Date) => (d ? realDailyWork.currentBusinessDate(d) : TODAY) },
  "@/lib/scope": {
    getCurrentDealerIds: async () => [], getCurrentManagerId: async () => null,
    getOfficerScope: async (c: AuthContext) => (c.role === Role.REGIONAL_MANAGER ? { all: false, ids: [c.userId, "so1", "so2"] } : { all: false, ids: [c.userId] }),
    assertOfficerInScope: async (c: AuthContext, id: string) => { if (c.userId !== id && !(c.role === Role.REGIONAL_MANAGER && ["so1", "so2"].includes(id))) throw new TestApiError(403, "no access"); },
  },
  "@/features/labels/service.server": { getResolvedLabels: async () => DEFAULT_LABELS },
  "@/features/schemes/scheme-planning.server": { runningSchemes: async () => [] },
  "@/features/planning/monthly.server": { getMonthly: async () => ({ monthlyMode: "PACK_SIZE", months: [], dealers: [] }) },
  "@/features/planning/monthly-plan.server": { resolveAddableSeasonalPlanId: async () => null, createDealerForOfficer: async () => ({}) },
  "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => 0 },
  "@/lib/recovery-config": { getAutoTasksEnabled: async () => false, getAppointmentPartyPlanningEnabled: async () => true, getCalendarEnabled: async () => true },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map(), resolveDealerDisplayNames: async () => new Map(), decorateDealerNames: async (r: unknown[]) => r, dealerDisplayName: (n: string) => n },
  "./auto-task-materialization.server": { materializeDueDailyWorkTasks: async () => ({}), materializeDueDailyWorkTasksInTransaction: async () => ({}), autoTasksApplyToRole: () => false },
  "./calendar-task-materialization.server": { materializeDueCalendarTasks: async () => ({}), calendarLinkedEntryIds: async () => [] },
  "./billing-task.server": { billingTasksForEntries: async () => [], billingLinkedEntryIds: async () => [], countUnconfirmedBillingTasks: async () => 0, BILLING_CONTRIBUTION_UNION: Prisma.empty },
})<typeof import("./service.server")>("src/features/daily-work/service.server.ts");

const ctx = (userId: string, role: Role): AuthContext => ({ userId, username: userId, role, groupId: "g1" }) as AuthContext;
const so1 = ctx("so1", Role.SALES_OFFICER), so2 = ctx("so2", Role.SALES_OFFICER), rm = ctx("rm", Role.REGIONAL_MANAGER);
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const eq = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const SENT = { documentStatus: "COMPLETE", chequeStatus: "INCOMPLETE", other: "by courier" }; // the owner's Doc Send By SO answers
const NOT_SENT = { documentNotSent: true, other: "will courier" }; // "Appointed, Document Not Sent"

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "DailyWorkEntry","DailyWorkDay","PartyMonthlyStatusEvent","PartyMonthlyDateChange","PartyMonthlyOption","PartyMonthlyEvent","PartyMonthlyPlan","PartyMonthlySheet","SeasonalPlan","SeasonalPlanSheet","Market","SeasonMonth","Season","Dealer","AuditLog","User","UserGroup" CASCADE`);
  await prisma.userGroup.create({ data: { id: "g1", name: "MP" } });
  for (const [id, role] of [["admin", Role.SUPER_ADMIN], ["so1", Role.SALES_OFFICER], ["so2", Role.SALES_OFFICER], ["rm", Role.REGIONAL_MANAGER]] as const)
    await prisma.user.create({ data: { id, name: id.toUpperCase(), username: id, passwordHash: "x", role, groupId: id === "admin" ? null : "g1" } });
  const season = await prisma.season.create({ data: { name: "Kharif", year: 2026, status: "OPEN" } });
  const closed = await prisma.season.create({ data: { name: "Old", year: 2025, status: "CLOSED" } });
  const oct = await prisma.seasonMonth.create({ data: { seasonId: season.id, name: "October", order: 1, calendarMonth: 10, calendarYear: 2026 } });
  const nov = await prisma.seasonMonth.create({ data: { seasonId: season.id, name: "November", order: 2, calendarMonth: 11, calendarYear: 2026 } });
  const closedOct = await prisma.seasonMonth.create({ data: { seasonId: closed.id, name: "October", order: 1, calendarMonth: 10, calendarYear: 2026 } });

  let n = 0;
  const sheets = new Map<string, string>(), spSheets = new Map<string, string>();
  /** One Monthly Party Planning ENTRY (with its Seasonal Plan market). */
  const entry = async (owner: string, name: string, over: { month?: typeof oct; seasonId?: string; approval?: string; op?: string; options?: string[] } = {}) => {
    const month = over.month ?? oct, seasonId = over.seasonId ?? season.id;
    const market = await prisma.market.create({ data: { name, nameKey: `${name.toLowerCase()}-${++n}` } });
    const spKey = `${owner}:${seasonId}`;
    if (!spSheets.has(spKey)) spSheets.set(spKey, (await prisma.seasonalPlanSheet.create({ data: { seasonId, ownerId: owner } })).id);
    const sp = await prisma.seasonalPlan.create({ data: { sheetId: spSheets.get(spKey)!, seasonId, ownerId: owner, marketId: market.id, approvalStatus: "APPROVED" } });
    const shKey = `${owner}:${month.id}`;
    if (!sheets.has(shKey)) sheets.set(shKey, (await prisma.partyMonthlySheet.create({ data: { seasonId, seasonMonthId: month.id, ownerId: owner, approvalStatus: "DRAFT" } })).id);
    const plan = await prisma.partyMonthlyPlan.create({ data: { sheetId: sheets.get(shKey)!, seasonalPlanId: sp.id, seasonId, seasonMonthId: month.id, ownerId: owner, marketId: market.id, marketNameAtPlanning: name, approvalStatus: over.approval ?? "APPROVED", opStatus: over.op ?? "NONE" } });
    for (const [i, party] of (over.options ?? []).entries()) await prisma.partyMonthlyOption.create({ data: { monthlyPlanId: plan.id, optionNo: i + 1, partyName: party } });
    return plan;
  };
  const m1 = await entry("so1", "Alpha Market", { options: ["Party One", "Party Two"] }); // two candidate parties, ONE market
  const m2 = await entry("so1", "Beta Market", { op: "DOC_SENT" });
  const m3 = await entry("so1", "Gamma Market", { op: "APPOINTED" });
  const m4 = await entry("so1", "Draft Market", { approval: "DRAFT" });
  await entry("so1", "Submitted Market", { approval: "PENDING_ADMIN" });
  await entry("so1", "Rejected Entry", { approval: "REJECTED" });
  await entry("so1", "November Market", { month: nov });
  await entry("so1", "Closed Season Market", { month: closedOct, seasonId: closed.id });
  const m8 = await entry("so2", "Other Officer Market");
  const m9 = await entry("rm", "RM Own Market");
  const m10 = await entry("so1", "Rejected Monthly", { op: "REJECTED" });
  const m11 = await entry("so1", "Delta Market"); // used for "Appointed, Document Not Sent"
  const m12 = await entry("so1", "Echo Market", { op: "DOC_NOT_SENT" }); // already Document Not Sent (an earlier report)
  const dealersBefore = await prisma.dealer.count();

  const read = (who: AuthContext, mode: "PLAN" | "REPORT", target?: string) => svc.getDailyAppointment(who, TODAY, target, mode);
  const events = (planId: string) => prisma.partyMonthlyStatusEvent.count({ where: { monthlyPlanId: planId } });

  /* ---- eligibility, scope, month/year, counts ---- */
  let p = await read(so1, "PLAN");
  eq(p.eligibleMarkets.map((m) => m.marketName).sort(), ["Alpha Market", "Beta Market", "Delta Market", "Echo Market", "Gamma Market", "Rejected Monthly"], "only the owner's APPROVED entries of THIS month in an OPEN season (no draft / submitted / rejected entry, other months, closed seasons or other officers)");
  eq([p.monthlyDealerPlan, p.pending], [6, 4], "Monthly Dealer Plan counts markets (not party options); Pending excludes terminal Appointed and Rejected");
  eq((await read(rm, "PLAN")).eligibleMarkets.map((m) => m.marketName), ["RM Own Market"], "an RM plans from their OWN approved plan");
  eq((await read(rm, "PLAN", "so1")).eligibleMarkets.length, 6, "an RM viewing an SO's work uses that SO's scope");
  assert.equal(await code(read(so2, "PLAN", "so1")), 403, "another SO cannot read it");
  eq([(await read(so2, "PLAN")).monthlyDealerPlan, (await read(so2, "PLAN")).pending], [1, 1]);

  /* ---- Daily Plan: save, duplicates, eligibility, legacy rows ---- */
  const plan = (...ids: string[]) => ids.map((monthlyPlanId) => ({ rowId: monthlyPlanId, monthlyPlanId }));
  assert.equal(await code(svc.saveDailyAppointment(so1, { workDate: TODAY, rows: plan(m1.id, m1.id) })), 422, "the same market twice in one batch is refused");
  for (const bad of [m4.id, m8.id, m9.id, "nope"]) assert.equal(await code(svc.saveDailyAppointment(so1, { workDate: TODAY, rows: plan(bad) })), 422, "an ineligible / foreign entry is refused");
  assert.equal(await code(svc.saveDailyAppointment(so1, { workDate: TODAY, rows: [{ rowId: "x", dealerName: "Typed Dealer", marketName: "Typed" }] })), 422, "a new typed dealer is no longer possible");
  assert.equal(await code(svc.saveDailyAppointment(so1, { workDate: "2026-11-02", rows: plan(m1.id) })), 422, "an October entry cannot be planned on a November date");
  await svc.saveDailyAppointment(so1, { workDate: TODAY, rows: plan(m1.id, m2.id, m11.id) });
  p = await read(so1, "PLAN");
  eq(p.rows.map((r) => [r.marketName, r.monthlyPlanId === r.rowId, r.legacy, r.dealerName, r.status]).sort(), [["Alpha Market", true, false, "", null], ["Beta Market", true, false, "", null], ["Delta Market", true, false, "", null]], "saved and reloaded: linked by plan id, market snapshot, no dealer name needed");
  const saved = await prisma.dailyWorkEntry.findMany({ where: { officerId: "so1", section: "APPOINTMENT", workDate: new Date(TODAY) } });
  eq(saved.map((r) => [r.monthlyPlanId === r.rowKey, r.marketId !== null, r.typedDealerName]).sort(), [[true, true, null], [true, true, null], [true, true, null]]);
  // the section counts as filled: No Plan is refused while it has rows
  assert.equal(await code(svc.setDailyNoPlan(so1, { workDate: TODAY, section: "APPOINTMENT", noPlan: true })), 409, "a linked market is data (No Plan is unavailable)");
  // legacy typed draft rows (e.g. a calendar-generated one) stay readable and untouched, and are never matched to a plan by name
  await prisma.$executeRaw`INSERT INTO "DailyWorkEntry" ("id","officerId","rowKey","workDate","batchId","section","typedDealerName","marketName","status","createdAt","updatedAt") VALUES ('legacy1','so1','cal-1',${TODAY}::date,'draft:so1:2026-10-14','APPOINTMENT','Old Dealer','Alpha Market','DRAFT',NOW(),NOW())`;
  p = await read(so1, "PLAN");
  const old = p.rows.find((r) => r.entryId === "legacy1")!;
  eq([old.legacy, old.monthlyPlanId, old.dealerName, old.marketName], [true, null, "Old Dealer", "Alpha Market"], "legacy row: readable, not linked by name even though the market text matches");
  await svc.saveDailyAppointment(so1, { workDate: TODAY, rows: [{ rowId: "cal-1", dealerName: "Old Dealer", marketName: "Alpha Market" }, ...plan(m1.id, m2.id, m11.id)] });
  eq((await read(so1, "PLAN")).rows.length, 4, "echoing the legacy row keeps it next to the new ones");
  await svc.saveDailyAppointment(so1, { workDate: TODAY, rows: [{ rowId: "cal-1", dealerName: "CHANGED", marketName: "x" }, ...plan(m1.id, m2.id, m11.id)] });
  eq((await read(so1, "PLAN")).rows.find((r) => r.entryId === "legacy1")?.dealerName, "Old Dealer", "a legacy row is never rewritten from the browser");
  await svc.saveDailyAppointment(so1, { workDate: TODAY, rows: plan(m1.id, m2.id, m11.id) }); // dropping the legacy draft removes it (as before)

  /* ---- submit the day: no dealer-name requirement ---- */
  for (const section of ["SALES", "RECOVERY", "VISITS", "OTHERS"]) await svc.setDailyNoPlan(so1, { workDate: TODAY, section, noPlan: true });
  const status = await svc.getDailyStatus(so1, TODAY);
  eq(status.sections.find((s) => s.section === "APPOINTMENT")?.status, "FILLED", "a linked market fills the appointment section");
  await svc.submitDailyWorkDay(so1, { workDate: TODAY });

  /* ---- Daily Report ---- */
  let r = await read(so1, "REPORT");
  eq([r.rows.length, r.canEnterStatus, r.rows.every((x) => x.status === null)], [3, true, true], "report rows start with NO result selected");
  const row = (name: string) => r.rows.find((x) => x.marketName === name)!;
  assert.equal((await svc.getDailyStatus(so1, TODAY)).reportSections.find((s) => s.section === "APPOINTMENT")?.complete, false, "results missing → the section is incomplete");

  // Not Appointed: only the Daily Work result changes.
  const monthlyBefore = JSON.stringify(await prisma.partyMonthlyPlan.findUnique({ where: { id: m2.id } }));
  await svc.enterAppointmentStatus(so1, { workDate: TODAY, entries: [{ entryId: row("Beta Market").entryId, status: "NOT_APPOINTED", dealerName: "Typed Then Cleared" }] });
  eq((await prisma.dailyWorkEntry.findUniqueOrThrow({ where: { id: row("Beta Market").entryId } })).reportedDealerName, null, "Not Appointed never keeps a dealer name, even when the request carries one");
  eq([await events(m2.id), JSON.stringify(await prisma.partyMonthlyPlan.findUnique({ where: { id: m2.id } })) === monthlyBefore, await prisma.dealer.count()], [0, true, dealersBefore], "Not Appointed changes Daily Work only: no monthly change, no event, no dealer");
  r = await read(so1, "REPORT");
  eq(row("Beta Market").status, "NOT_APPOINTED", "the saved result is restored on reopen");

  // A new Appointed can never come through the generic result save (stale / forged autosave).
  assert.equal(await code(svc.enterAppointmentStatus(so1, { workDate: TODAY, entries: [{ entryId: row("Alpha Market").entryId, status: "APPOINTED" }] })), 409, "an unverified Appointed is refused");
  eq([(await read(so1, "REPORT")).rows.find((x) => x.marketName === "Alpha Market")?.status, await events(m1.id)], [null, 0]);

  // Failure leaves everything intact: no / invalid document selection → nothing saved (and the entered name is not recorded either).
  for (const bad of [undefined, {}, { documents: false, checks: false }, { documents: true, checks: true }, { documentStatus: "COMPLETE" }, { documentNotSent: true, documentStatus: "COMPLETE" }]) assert.notEqual(await code(svc.recordAppointedResult(so1, { workDate: TODAY, entryId: row("Alpha Market").entryId, sent: bad, dealerName: "Premature Name" })), 0);
  eq((await prisma.dailyWorkEntry.findUniqueOrThrow({ where: { id: row("Alpha Market").entryId } })).reportedDealerName, null, "a failed / cancelled Appointed does not record the name");
  assert.equal(await code(svc.enterAppointmentStatus(so1, { workDate: TODAY, entries: [{ entryId: row("Alpha Market").entryId, status: "APPOINTED", dealerName: "Sneaky" }] })), 409, "a name cannot make an unverified Appointed");
  assert.notEqual(await code(svc.recordAppointedResult(so1, { workDate: TODAY, entryId: row("Alpha Market").entryId, sent: SENT, dealerName: "x".repeat(201) })), 0, "dealer name length is validated (schema error → 422 at the route)");
  eq([(await prisma.partyMonthlyPlan.findUniqueOrThrow({ where: { id: m1.id } })).opStatus, await events(m1.id), (await read(so1, "REPORT")).rows.find((x) => x.marketName === "Alpha Market")?.status], ["NONE", 0, null], "a failed save leaves the monthly status and the daily result as they were");
  // Someone else cannot act on the row.
  assert.equal(await code(svc.recordAppointedResult(so2, { workDate: TODAY, entryId: row("Alpha Market").entryId, sent: SENT })), 409);
  assert.equal(await code(svc.recordAppointedResult(rm, { workDate: TODAY, entryId: row("Alpha Market").entryId, sent: SENT })), 409, "an RM cannot record an SO's result");

  // Appointed: the owner's monthly step + the daily result, once — even when clicked repeatedly / concurrently.
  const results = await Promise.all([1, 2, 3].map(() => svc.recordAppointedResult(so1, { workDate: TODAY, entryId: row("Alpha Market").entryId, sent: SENT, dealerName: "  Ravi Traders  " }).then((x) => x, (e: { status?: number }) => ({ err: e.status }))));
  assert.ok(results.some((x) => "transitioned" in x && x.transitioned), "one of the clicks performed the transition");
  eq(await events(m1.id), 1, "ONE logical action → ONE monthly status event");
  const m1After = await prisma.partyMonthlyPlan.findUniqueOrThrow({ where: { id: m1.id } });
  const ev = await prisma.partyMonthlyStatusEvent.findFirstOrThrow({ where: { monthlyPlanId: m1.id } });
  eq([m1After.opStatus, ev.previousStatus, ev.newStatus, ev.actorId, (ev.sentInfo as { other: string }).other, m1After.appointedDealerId], ["DOC_SENT", "NONE", "DOC_SENT", "so1", "by courier", null], "the existing owner transition: Doc Send By SO — not Appointed, no dealer");
  const dayRow = await prisma.dailyWorkEntry.findUniqueOrThrow({ where: { id: row("Alpha Market").entryId } });
  eq([dayRow.resultStatus, dayRow.resultEventId === ev.id], ["APPOINTED", true], "the daily result references the successful linked action");
  assert.equal(await prisma.dealer.count(), dealersBefore, "no dealer is created by a document submission");
  eq([dayRow.reportedDealerName, (await read(so1, "REPORT")).rows.find((x) => x.marketName === "Alpha Market")?.reportedDealerName], ["Ravi Traders", "Ravi Traders"], "the name is saved (trimmed) WITH the Appointed result and restored on reopen");
  eq(await prisma.partyMonthlyOption.count({ where: { monthlyPlanId: m1.id, partyName: { contains: "Ravi" } } }), 0, "it never touches the monthly candidate party names");
  // Editing the name later: only the name changes — no second transition, same status event.
  await svc.enterAppointmentStatus(so1, { workDate: TODAY, entries: [{ entryId: row("Alpha Market").entryId, status: "APPOINTED", dealerName: "Ravi Traders Pvt Ltd" }] });
  const edited = await prisma.dailyWorkEntry.findUniqueOrThrow({ where: { id: row("Alpha Market").entryId } });
  eq([edited.reportedDealerName, edited.resultEventId === ev.id, await events(m1.id), (await prisma.partyMonthlyPlan.findUniqueOrThrow({ where: { id: m1.id } })).opStatus, await prisma.dealer.count()], ["Ravi Traders Pvt Ltd", true, 1, "DOC_SENT", dealersBefore], "editing the name replays nothing and creates no dealer");
  await svc.enterAppointmentStatus(so1, { workDate: TODAY, entries: [{ entryId: row("Alpha Market").entryId, status: "APPOINTED" }] });
  eq((await prisma.dailyWorkEntry.findUniqueOrThrow({ where: { id: row("Alpha Market").entryId } })).reportedDealerName, null, "a blank name clears it");
  await svc.enterAppointmentStatus(so1, { workDate: TODAY, entries: [{ entryId: row("Alpha Market").entryId, status: "APPOINTED", dealerName: "Ravi Traders Pvt Ltd" }] });
  const retry = await svc.recordAppointedResult(so1, { workDate: TODAY, entryId: row("Alpha Market").entryId, sent: SENT });
  eq([retry.transitioned, await events(m1.id)], [false, 1], "a retry replays nothing");
  // Totals: Pending is unchanged by a document submission (not a final appointment).
  eq([(await read(so1, "REPORT")).pending, (await read(so1, "REPORT")).monthlyDealerPlan], [4, 6], "document sent is not appointed: Pending is unchanged");
  // Appointed stays locked once it moved the monthly status.
  assert.equal(await code(svc.enterAppointmentStatus(so1, { workDate: TODAY, entries: [{ entryId: row("Alpha Market").entryId, status: "NOT_APPOINTED" }] })), 409, "a later daily change cannot silently reverse a recorded monthly status event");
  await svc.enterAppointmentStatus(so1, { workDate: TODAY, entries: [{ entryId: row("Alpha Market").entryId, status: "APPOINTED" }] }); // an echo is harmless
  eq(await events(m1.id), 1);

  // An entry that already progressed: no second transition, the result references its latest event; a rejected one is refused.
  const progressed = await svc.recordAppointedResult(so1, { workDate: TODAY, entryId: row("Beta Market").entryId, dealerName: "Beta Dealer" });
  eq((await read(so1, "REPORT")).rows.find((x) => x.marketName === "Beta Market")?.reportedDealerName, "Beta Dealer", "an already-progressed entry also records the name with the result");
  eq([progressed.transitioned, await events(m2.id)], [false, 0], "already Doc Sent: nothing replayed (it has no status event of its own: reference is empty)");
  assert.equal((await prisma.partyMonthlyPlan.findUniqueOrThrow({ where: { id: m2.id } })).opStatus, "DOC_SENT");
  // "Appointed, Document Not Sent" through the Daily Report: ONE transaction saves the Appointed result, the Dealer Name and the monthly status Document Not Sent.
  const deltaEntry = row("Delta Market").entryId, dealersNow = await prisma.dealer.count(), pendingBefore = (await read(so1, "REPORT")).pending;
  assert.notEqual(await code(svc.recordAppointedResult(so1, { workDate: TODAY, entryId: deltaEntry, sent: { documentNotSent: true, documentStatus: "COMPLETE" }, dealerName: "Contradiction" })), 0, "the special option cannot be combined with answers");
  assert.notEqual(await code(svc.recordAppointedResult(so1, { workDate: TODAY, entryId: deltaEntry, sent: { documentStatus: "INCOMPLETE" }, dealerName: "Half Answered" })), 0, "Cheque unanswered");
  eq([(await prisma.partyMonthlyPlan.findUniqueOrThrow({ where: { id: m11.id } })).opStatus, await events(m11.id), (await prisma.dailyWorkEntry.findUniqueOrThrow({ where: { id: deltaEntry } })).reportedDealerName, (await prisma.dailyWorkEntry.findUniqueOrThrow({ where: { id: deltaEntry } })).resultStatus], ["NONE", 0, null, null], "refused attempts save nothing");
  const nsResults = await Promise.all([1, 2, 3].map(() => svc.recordAppointedResult(so1, { workDate: TODAY, entryId: deltaEntry, sent: NOT_SENT, dealerName: "  Delta Traders  " }).then((x) => x, (e: { status?: number }) => ({ err: e.status }))));
  assert.ok(nsResults.some((x) => "transitioned" in x && x.transitioned), "one click performed the transition");
  const deltaPlan = await prisma.partyMonthlyPlan.findUniqueOrThrow({ where: { id: m11.id } });
  const nsEvent = await prisma.partyMonthlyStatusEvent.findFirstOrThrow({ where: { monthlyPlanId: m11.id } });
  eq([deltaPlan.opStatus, await events(m11.id), nsEvent.previousStatus, nsEvent.newStatus, deltaPlan.appointedDealerId], ["DOC_NOT_SENT", 1, "NONE", "DOC_NOT_SENT", null], "monthly status Document Not Sent, one event, no Document / Cheque answers, no dealer");
  assert.deepEqual(nsEvent.sentInfo, { documentStatus: null, chequeStatus: null, documentNotSent: true, other: "will courier" }, "no Document / Cheque answers are stored with the special option");
  const deltaDay = await prisma.dailyWorkEntry.findUniqueOrThrow({ where: { id: deltaEntry } });
  eq([deltaDay.resultStatus, deltaDay.resultEventId === nsEvent.id, deltaDay.reportedDealerName, await prisma.dealer.count()], ["APPOINTED", true, "Delta Traders", dealersNow], "daily result Appointed + event link + Dealer Name saved together; no dealer created");
  eq(await prisma.partyMonthlyDateChange.count({ where: { monthlyPlanId: m11.id } }), 1, "a genuine transition set the Conversion Date once");
  eq([(await read(so1, "REPORT")).pending], [pendingBefore], "Document Not Sent stays pending (the Pending total is unchanged)");
  assert.equal((await svc.recordAppointedResult(so1, { workDate: TODAY, entryId: deltaEntry, sent: NOT_SENT })).transitioned, false, "a retry replays nothing");
  eq(await events(m11.id), 1);
  // Reopen later: the SAME form submits the answers; Doc Send By SO follows from Document Not Sent (see the later batch below).
  // The day is complete → report completion
  assert.equal((await svc.getDailyStatus(so1, TODAY)).reportSections.find((s) => s.section === "APPOINTMENT")?.complete, true, "both results saved → the section is complete");

  // Performance counts the linked markets as appointments (planned) and the Appointed result (actual, once the report is final).
  const perf = await svc.getDailyPerformance(so1, { from: TODAY, to: TODAY });
  assert.equal(perf.summary.sections.appointment.planned, 3, "appointment totals count the linked markets");

  // Final submission: once the day is finalized the name can no longer change.
  await prisma.$executeRaw`UPDATE "DailyWorkDay" SET "status" = 'FINALIZED' WHERE "officerId" = 'so1' AND "workDate" = ${TODAY}::date`;
  assert.equal(await code(svc.enterAppointmentStatus(so1, { workDate: TODAY, entries: [{ entryId: row("Alpha Market").entryId, status: "APPOINTED", dealerName: "Too Late" }] })), 409, "read-only after the final report");
  await prisma.$executeRaw`UPDATE "DailyWorkDay" SET "status" = 'OPEN' WHERE "officerId" = 'so1' AND "workDate" = ${TODAY}::date`;
  // Report window: after the deadline nothing can be recorded.
  realDailyWork.dailyWorkClock.now = () => new Date("2026-10-15T09:00:00Z"); // 14:30 IST next day, past noon
  assert.equal(await code(svc.recordAppointedResult(so1, { workDate: TODAY, entryId: row("Beta Market").entryId })), 422, "report deadline");
  realDailyWork.dailyWorkClock.now = () => new Date(`${TODAY}T06:00:00Z`);

  // A later planning batch the same day: the same market may be selected again (a follow-up), a Monthly-Rejected entry cannot be recorded as Appointed.
  await svc.saveDailyAppointment(so1, { workDate: TODAY, rows: plan(m1.id, m10.id, m11.id, m12.id) });
  for (const section of ["SALES", "RECOVERY", "VISITS", "OTHERS"]) await svc.setDailyNoPlan(so1, { workDate: TODAY, section, noPlan: true });
  await svc.submitDailyWorkDay(so1, { workDate: TODAY });
  r = await read(so1, "REPORT");
  assert.equal(r.rows.filter((x) => x.marketName === "Alpha Market").length, 2, "a follow-up selection of the same market in a later batch is allowed");
  const rejected = r.rows.find((x) => x.marketName === "Rejected Monthly")!;
  assert.equal(await code(svc.recordAppointedResult(so1, { workDate: TODAY, entryId: rejected.entryId, sent: SENT })), 409, "a monthly-rejected entry cannot be recorded as Appointed");
  eq([await events(m10.id), (await read(so1, "REPORT")).rows.find((x) => x.entryId === rejected.entryId)?.status], [0, null]);
  // Later submission from Document Not Sent: the follow-up row of Delta uses the same form → Doc Send By SO; Echo (already Document Not Sent) with the special option again changes nothing.
  const laterDelta = r.rows.filter((x) => x.marketName === "Delta Market" && x.status === null)[0]!;
  const laterEcho = r.rows.find((x) => x.marketName === "Echo Market")!;
  eq([laterDelta.monthlyStatus, laterEcho.monthlyStatus], ["DOC_NOT_SENT", "DOC_NOT_SENT"], "the daily report shows the monthly status");
  const echoAgain = await svc.recordAppointedResult(so1, { workDate: TODAY, entryId: laterEcho.entryId, sent: NOT_SENT, dealerName: "Echo Dealer" });
  eq([echoAgain.transitioned, await events(m12.id), (await prisma.partyMonthlyPlan.findUniqueOrThrow({ where: { id: m12.id } })).opStatus, (await prisma.dailyWorkEntry.findUniqueOrThrow({ where: { id: laterEcho.entryId } })).reportedDealerName], [false, 0, "DOC_NOT_SENT", "Echo Dealer"], "special option on an already Document Not Sent row: result + name saved, no second transition");
  const progression = await svc.recordAppointedResult(so1, { workDate: TODAY, entryId: laterDelta.entryId, sent: { documentStatus: "INCOMPLETE", chequeStatus: "INCOMPLETE", other: "second attempt" }, dealerName: "Delta Traders" });
  const deltaAfter = await prisma.partyMonthlyPlan.findUniqueOrThrow({ where: { id: m11.id } });
  const progEvents = await prisma.partyMonthlyStatusEvent.findMany({ where: { monthlyPlanId: m11.id }, orderBy: { createdAt: "asc" } });
  eq([progression.transitioned, deltaAfter.opStatus, progEvents.map((e) => [e.previousStatus, e.newStatus]), deltaAfter.appointedDealerId], [true, "DOC_SENT", [["NONE", "DOC_NOT_SENT"], ["DOC_NOT_SENT", "DOC_SENT"]], null], "Document Not Sent → Doc Send By SO through the same form; both Incomplete is an explicit answer; still no dealer");
  assert.deepEqual(progEvents[1]!.sentInfo, { documentStatus: "INCOMPLETE", chequeStatus: "INCOMPLETE", documentNotSent: false, other: "second attempt" });
  eq((await prisma.dealer.count()), dealersNow, "no dealer anywhere in this flow");
  void m3; void m9;
  console.log("appointment.integration.ts — all assertions passed");
}
main().then(() => prisma.$disconnect(), async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
