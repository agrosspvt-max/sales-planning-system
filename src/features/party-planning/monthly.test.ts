/**
 * Monthly Planning service contracts (real service + real season helpers, in-memory database): a Monthly Plan is created for a CHOSEN open season
 * and one of ITS months (calendar order), opened by id; plans of different seasons / months coexist; the Seasonal-Plan → market dependency;
 * two independent options; the transition rules per role; the append-only timeline; scope and spoof-proofing. Nothing uses a "current" season / month.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { currentBusinessDate } from "@/lib/daily-work";
import type { AuthContext } from "@/lib/http";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const USERS = [
  { id: "admin", name: "Admin", role: Role.SUPER_ADMIN, groupId: null },
  { id: "rm1", name: "RM One", role: Role.REGIONAL_MANAGER, groupId: "g1" },
  { id: "so1", name: "Officer One", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "so2", name: "Officer Two", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "so3", name: "Officer Three", role: Role.SALES_OFFICER, groupId: "g2" },
];
// The REAL Kharif 2026 shape: created June–Nov (order 1–6), extended with April + May (order 7–8) — `order` is NOT chronological.
const KHARIF_MONTHS = [["June", 1, 6], ["July", 2, 7], ["August", 3, 8], ["September", 4, 9], ["October", 5, 10], ["November", 6, 11], ["April", 7, 4], ["May", 8, 5]]
  .map(([name, order, calendarMonth]) => ({ id: `sm-${String(name).toLowerCase()}`, seasonId: "s-kharif", name, order, calendarMonth, calendarYear: 2026 }));
const RABI_MONTHS = [{ id: "sm-r-jan", seasonId: "s-rabi", name: "January", order: 1, calendarMonth: 1, calendarYear: 2027 }, { id: "sm-r-nov", seasonId: "s-rabi", name: "November", order: 2, calendarMonth: 11, calendarYear: 2026 }, { id: "sm-r-dec", seasonId: "s-rabi", name: "December", order: 3, calendarMonth: 12, calendarYear: 2026 }];
const OLD_MONTHS = [{ id: "sm-old-jun", seasonId: "s-old", name: "June", order: 1, calendarMonth: 6, calendarYear: 2025 }];
const ALL_MONTHS = [...KHARIF_MONTHS, ...RABI_MONTHS, ...OLD_MONTHS];

function makeDb() {
  const sp = (id: string, ownerId: string, seasonId: string, marketId: string, approvalStatus: string, partyName: string) => ({ id, ownerId, seasonId, marketId, approvalStatus, partyName, approvedMarketSource: approvalStatus === "APPROVED" ? (marketId === "m-new" ? "REQUESTED" : "EXISTING") : null, approvedMarketPotential: approvalStatus === "APPROVED" ? (marketId === "m-new" ? "A" : "B") : null, appointmentStatus: approvalStatus === "APPROVED" ? "PENDING" : null, appointedAt: null, createdAt: new Date() });
  const t = {
    sheets: [] as Row[], plans: [] as Row[], options: [] as Row[], events: [] as Row[], audit: [] as Row[],
    seasons: [
      { id: "s-kharif", name: "Kharif", year: 2026, status: "OPEN", startMonth: 4, startYear: 2026, endMonth: 11, endYear: 2026 },
      { id: "s-rabi", name: "Rabi", year: 2026, status: "OPEN", startMonth: 11, startYear: 2026, endMonth: 1, endYear: 2027 },
      { id: "s-old", name: "Season", year: 2025, status: "CLOSED", startMonth: 6, startYear: 2025, endMonth: 6, endYear: 2025 },
    ] as Row[],
    seasonalPlans: [
      sp("sp-so1", "so1", "s-kharif", "m-exist", "APPROVED", "SO1 tentative"), sp("sp-so1-new", "so1", "s-kharif", "m-new", "APPROVED", "SO1 new-market party"),
      sp("sp-so1-draft", "so1", "s-kharif", "m-exist", "DRAFT", "draft"), sp("sp-so1-pending", "so1", "s-kharif", "m-exist", "PENDING_ADMIN", "awaiting"),
      sp("sp-so1-rabi", "so1", "s-rabi", "m-exist", "APPROVED", "SO1 rabi party"), sp("sp-so1-old", "so1", "s-old", "m-exist", "APPROVED", "old season"),
      sp("sp-so2", "so2", "s-kharif", "m-new", "APPROVED", "SO2 party"), sp("sp-rm1", "rm1", "s-kharif", "m-exist", "APPROVED", "RM party"),
    ] as Row[],
    markets: [{ id: "m-exist", name: "Pipariya", source: "EXISTING", potential: "B" }, { id: "m-new", name: "Bareli", source: "REQUESTED", potential: "A" }, { id: "m-unseasonal", name: "Bhopal Rural", source: "EXISTING", potential: "C" }] as Row[],
    dateChanges: [] as Row[], statusEvents: [] as Row[], dealers: [] as Row[],
    dealerCalls: [] as Row[], failDealer: false,
    failNextEvent: false,
    onClaim: null as null | (() => void), // lets a test change an option "concurrently", right before the service claims it
  };
  let seq = 0, clock = 1_000;
  const tick = () => new Date(Date.now() + ++clock); // strictly increasing created times
  const matches = (row: Row, where: Row | undefined): boolean => !where || Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Row[]).every((c) => matches(row, c));
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    if (key === "ownerId_seasonMonthId") return row.ownerId === cond.ownerId && row.seasonMonthId === cond.seasonMonthId;
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Row;
      if ("in" in c) return c.in.includes(row[key]);
      if ("contains" in c) return String(row[key] ?? "").toLowerCase().includes(String(c.contains).toLowerCase());
    }
    return (row[key] ?? null) === (cond ?? null);
  });
  const seasonOf = (id: string) => t.seasons.find((s) => s.id === id)!;
  const monthOf = (id: string) => ALL_MONTHS.find((m) => m.id === id)!;
  const itemsOf = (sheetId: string) => t.plans.filter((p) => p.sheetId === sheetId).map((p) => ({ updatedAt: p.updatedAt, opStatus: p.opStatus, approvalStatus: p.approvalStatus, submittedAt: p.submittedAt, rejectionStage: p.rejectionStage, rejectionReason: p.rejectionReason, options: t.options.filter((o) => o.monthlyPlanId === p.id).map((o) => ({ optionNo: o.optionNo, partyName: o.partyName, updatedAt: o.updatedAt })) }));
  const sheetView = (r: Row) => ({ ...r, season: { name: seasonOf(r.seasonId).name, year: seasonOf(r.seasonId).year, status: seasonOf(r.seasonId).status }, seasonMonth: { id: r.seasonMonthId, name: monthOf(r.seasonMonthId).name, calendarMonth: monthOf(r.seasonMonthId).calendarMonth, calendarYear: monthOf(r.seasonMonthId).calendarYear }, owner: { name: USERS.find((u) => u.id === r.ownerId)?.name }, items: itemsOf(r.id) });
  const planView = (p: Row) => {
    const sm = monthOf(p.seasonMonthId);
    return { ...p, sheet: { approvalStatus: t.sheets.find((x) => x.id === p.sheetId)!.approvalStatus }, seasonalPlan: { createdAt: t.seasonalPlans.find((x) => x.id === p.seasonalPlanId)!.createdAt }, dateChanges: t.dateChanges.filter((c) => c.monthlyPlanId === p.id), statusEvents: t.statusEvents.filter((e) => e.monthlyPlanId === p.id), season: { status: seasonOf(p.seasonId).status }, seasonMonth: { name: sm.name, calendarMonth: sm.calendarMonth, calendarYear: sm.calendarYear }, owner: { name: USERS.find((u) => u.id === p.ownerId)?.name, groupId: USERS.find((u) => u.id === p.ownerId)?.groupId ?? null }, appointedDealer: p.appointedDealerId ? { id: p.appointedDealerId, name: t.dealers.find((d) => d.id === p.appointedDealerId)?.name } : null,
      options: t.options.filter((o) => o.monthlyPlanId === p.id).sort((a, b) => a.optionNo - b.optionNo) };
  };
  const sortBy = (rows: Row[], orderBy: Row | Row[]) => { const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => Object.keys(o)[0]!); return [...rows].sort((a, b) => { for (const k of keys) { const d = a[k] - b[k]; if (d) return d; } return 0; }); };
  const prisma = {
    season: { findUnique: async ({ where }: Row) => { const s = t.seasons.find((x) => x.id === where.id); return s ? { ...s } : null; } },
    seasonMonth: { findMany: async ({ where, orderBy }: Row) => sortBy(ALL_MONTHS.filter((m) => m.seasonId === where.seasonId), orderBy ?? { order: "asc" }) },
    user: { findUnique: async ({ where }: Row) => USERS.find((u) => u.id === where.id) ?? null, findMany: async ({ where }: Row) => USERS.filter((u) => where.id.in.includes(u.id)) },
    seasonalPlan: {
      findUnique: async ({ where }: Row) => { const p = t.seasonalPlans.find((x) => x.id === where.id); return p ? { ...p, market: t.markets.find((m) => m.id === p.marketId) } : null; },
      findMany: async ({ where }: Row) => t.seasonalPlans.filter((p) => matches(p, where)).map((p) => ({ ...p, market: t.markets.find((m) => m.id === p.marketId) })),
      count: async ({ where }: Row) => t.seasonalPlans.filter((p) => matches(p, where)).length,
      updateMany: async ({ where, data }: Row) => { const rows = t.seasonalPlans.filter((p) => matches(p, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
    },
    partyMonthlySheet: {
      create: async ({ data }: Row) => { const row = { id: `ms${++seq}`, approvalStatus: "DRAFT", submittedAt: null, rmDecidedById: null, rmDecidedAt: null, adminDecidedById: null, adminDecidedAt: null, rejectionStage: null, rejectionReason: null, ...data, createdAt: tick(), updatedAt: tick() }; t.sheets.push(row); return sheetView(row); },
      updateMany: async ({ where, data }: Row) => { const rows = t.sheets.filter((r) => matches(r, where)); rows.forEach((r) => Object.assign(r, data, { updatedAt: tick() })); return { count: rows.length }; },
      findUnique: async ({ where }: Row) => { const r = t.sheets.find((x) => matches(x, where)); return r ? sheetView(r) : null; },
      findMany: async ({ where }: Row) => t.sheets.filter((r) => matches(r, where)).map(sheetView),
    },
    partyMonthlyPlan: {
      create: async ({ data }: Row) => { const row = { id: `mp${++seq}`, opStatus: "NONE", opStatusChangedAt: null, appointedDealerId: null, approvalStatus: "DRAFT", submittedAt: null, rmDecidedById: null, rmDecidedAt: null, adminDecidedById: null, adminDecidedAt: null, rejectionStage: null, rejectionReason: null, ...data, createdAt: tick(), updatedAt: tick() }; t.plans.push(row); return { ...row }; },
      updateMany: async ({ where, data }: Row) => { t.onClaim?.(); t.onClaim = null; const rows = t.plans.filter((p) => matches(p, where)); rows.forEach((r) => Object.assign(r, data, { updatedAt: tick() })); return { count: rows.length }; },
      findUnique: async ({ where }: Row) => { const p = t.plans.find((x) => x.id === where.id); return p ? planView(p) : null; },
      findFirst: async ({ where }: Row) => { const p = t.plans.find((x) => matches(x, where)); return p ? { ...p } : null; },
      findMany: async ({ where }: Row) => t.plans.filter((p) => matches(p, where)).map(planView),
      update: async ({ where, data }: Row) => { const p = t.plans.find((x) => x.id === where.id)!; Object.assign(p, data, { updatedAt: tick() }); return { ...p }; },
    },
    partyMonthlyOption: {
      create: async ({ data }: Row) => { const row = { id: `op${++seq}`, sentInfo: null, sentById: null, sentAt: null, receivedInfo: null, receivedById: null, receivedAt: null, actualPartyName: null, actualAppointedOn: null, rejectionReason: null, statusChangedAt: new Date(), updatedAt: tick(), ...data }; t.options.push(row); return { ...row }; },
      update: async ({ where, data }: Row) => { const o = t.options.find((x) => x.id === where.id)!; Object.assign(o, data, { updatedAt: tick() }); return { ...o }; },
      updateMany: async ({ where, data }: Row) => { t.onClaim?.(); t.onClaim = null; const rows = t.options.filter((o) => matches(o, where)); rows.forEach((r) => Object.assign(r, data, { updatedAt: tick() })); return { count: rows.length }; },
    },
    // Append-only by construction: the fake exposes NO update / delete for events (the real table has a trigger that refuses both).
    partyMonthlyStatusEvent: { create: async ({ data }: Row) => { if (t.failNextEvent) { t.failNextEvent = false; throw new Error("event write failed"); } const row = { id: `se${++seq}`, ...data, remarks: data.remarks ?? null, sentInfo: data.sentInfo ?? null, receivedInfo: data.receivedInfo ?? null, createdAt: tick() }; t.statusEvents.push(row); return { ...row }; } },
    partyMonthlyDateChange: { create: async ({ data }: Row) => { const row = { id: `dc${++seq}`, ...data, createdAt: tick() }; t.dateChanges.push(row); return { ...row }; } },
    partyMonthlyEvent: { create: async ({ data }: Row) => { if (t.failNextEvent) { t.failNextEvent = false; throw new Error("event write failed"); } const row = { id: `ev${++seq}`, ...data, createdAt: tick() }; t.events.push(row); return { ...row }; } },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      const snap = structuredClone([t.sheets, t.plans, t.options, t.events, t.audit, t.seasonalPlans, t.dateChanges, t.statusEvents, t.dealers]);
      try { return await fn(prisma); } catch (e) { [t.sheets, t.plans, t.options, t.events, t.audit, t.seasonalPlans, t.dateChanges, t.statusEvents, t.dealers] = snap as Row[][]; throw e; }
    },
  };
  return { prisma, t };
}

const TABLES = new WeakMap<object, ReturnType<typeof makeDb>["t"]>();
function loadService() {
  const db = makeDb();
  const getOfficerScope = async (ctx: AuthContext) => {
    if (ctx.role === Role.SUPER_ADMIN) return { all: true, ids: [] as string[] };
    if (ctx.role === Role.SALES_OFFICER) return { all: false, ids: [ctx.userId] };
    return { all: false, ids: [ctx.userId, ...USERS.filter((u) => u.role === Role.SALES_OFFICER && u.groupId === ctx.groupId).map((u) => u.id)] };
  };
  const load = testLoader({
    "@/lib/prisma": { prisma: db.prisma },
    "@/lib/http": { ApiError: TestApiError },
    "@/lib/audit": { writeAudit: async (p: Row) => { db.t.audit.push({ ...p }); } },
    // The REAL createDealerForOfficer (Dealer Alias → Create Dealer service) needs a whole dealer database; here a faithful stand-in records what it was called with,
    // writes through the CALLER'S transaction (so rollbacks are real), reports duplicates unless forced, and can be made to fail.
    "@/features/planning/monthly-plan.server": { createDealerForOfficer: async (ctx: AuthContext, raw: Row, opts: { tx?: unknown } = {}) => {
      db.t.dealerCalls.push({ ctx, raw, usedCallerTx: opts.tx === db.prisma });
      if (ctx.role !== Role.SUPER_ADMIN) throw new TestApiError(403, "Only a Super Admin can create a dealer for an officer");
      if (!raw.name) throw new TestApiError(422, "Dealer name is required");
      if (!raw.force && db.t.dealers.some((d) => d.name.toLowerCase() === String(raw.name).toLowerCase())) return { duplicates: [{ id: "existing", name: "Existing dealer", reason: "Same name", score: 1 }] };
      if (db.t.failDealer) { db.t.failDealer = false; throw new TestApiError(409, `An alias "${raw.aliasName}" already exists`); }
      const dealer = { id: `d${db.t.dealers.length + 1}`, name: String(raw.name), officerId: raw.officerId, groupId: raw.groupId, aliasName: raw.aliasName || raw.name, town: raw.town ?? null, addToSeasonalPlan: raw.addToSeasonalPlan === true, status: "ACTIVE" };
      db.t.dealers.push(dealer);
      return { dealerId: dealer.id, dealerName: dealer.name };
    } },
    "@/lib/scope": { getOfficerScope, getCurrentManagerId: async (officerId: string) => { const me = USERS.find((u) => u.id === officerId); return USERS.find((u) => u.role === Role.REGIONAL_MANAGER && u.groupId === me?.groupId && u.id !== officerId)?.id ?? null; } },
    // Only the Seasons module's OPEN-season LIST is faked; the season/month helpers in season-info.server.ts (calendar ordering, period text) run for real.
    "@/features/seasons/service.server": { listSeasons: async (_search: string, activeOnly: boolean) => db.t.seasons.filter((s) => !activeOnly || s.status === "OPEN").map((s) => ({ id: s.id })) },
  });
  const service = load("src/features/party-planning/monthly.server.ts") as typeof import("./monthly.server");
  TABLES.set(service, db.t);
  return { service, ...db };
}

const ctxOf = (userId: string): AuthContext => { const u = USERS.find((x) => x.id === userId)!; return { userId, role: u.role, username: userId, groupId: u.groupId, designation: null } as unknown as AuthContext; };
const SO1 = ctxOf("so1"), SO2 = ctxOf("so2"), SO3 = ctxOf("so3"), RM1 = ctxOf("rm1"), ADMIN = ctxOf("admin");
async function status(fn: () => Promise<unknown>): Promise<number> { try { await fn(); return 0; } catch (e) { return (e as { status?: number }).status ?? -1; } }
const DOCS = { documents: true, checks: true, other: true, otherDetails: "GST certificate" };
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
type Svc = ReturnType<typeof loadService>["service"];
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
/** The caller's Monthly Plan for a (season, month) — created on first use. */
async function sheetOf(service: Svc, ctx: AuthContext, seasonId = "s-kharif", seasonMonthId = "sm-june") {
  try { return plain(await service.createMonthlySheet(ctx, { seasonId, seasonMonthId })); }
  catch (e) { if ((e as { status?: number }).status !== 409) throw e; return plain((await service.listMonthlySheets(ctx)).find((s) => s.seasonMonthId === seasonMonthId && s.own)!); }
}
async function planFor(service: Svc, extra: Row = {}, ctx: AuthContext = SO1) {
  const sheet = await sheetOf(service, ctx, extra.seasonId ?? "s-kharif", extra.seasonMonthId ?? "sm-june");
  return service.createMonthlyPlan(ctx, { sheetId: sheet.id, seasonalPlanId: "sp-so1", planDate: "2026-06-15", option1Party: "Party A", option2Party: "Party B", ...extra });
}
/** Approve the plan (the row status workflow only starts once the PLAN is approved — plan approval has its own tests), then change the row's status. */
const approveSheetOf = (service: Svc, plan: { id: string }) => { TABLES.get(service)!.plans.find((x) => x.id === plan.id)!.approvalStatus = "APPROVED"; }; // (the ENTRY is what gets approved)
const DEALER = { name: "ABC Traders", aliasName: "ABC TRADERS (TALLY)", officerId: "so1", groupId: "g1", town: "Pipariya", addToSeasonalPlan: true };
const appoint = (service: Svc, ctx: AuthContext, plan: { id: string; sheetId?: string }, body: Row = {}, opts: { approve?: boolean } = {}) => {
  if (opts.approve !== false) approveSheetOf(service, plan);
  return service.appointRow(ctx, plan.id, { dealer: DEALER, ...body });
};
const move = (service: Svc, ctx: AuthContext, plan: { id: string; sheetId?: string }, body: Row, opts: { approve?: boolean } = {}) => {
  if (opts.approve !== false) approveSheetOf(service, plan);
  return service.changeRowStatus(ctx, plan.id, body);
};

async function main() {
  /* ---- create a Monthly Plan: the user CHOOSES a season and one of ITS months ---- */
  {
    const { service, t } = loadService();
    const o = plain(await service.getMonthlyOptions(SO1));
    assert.deepEqual(o.seasons.map((s) => s.name), ["Kharif", "Rabi"], "every OPEN season is offered; the closed one is not — none is pre-selected");
    const kharif = o.seasons[0]!;
    assert.deepEqual(kharif.months.map((m) => m.name), ["April", "May", "June", "July", "August", "September", "October", "November"], "the months of the CHOSEN season, in CALENDAR order (SeasonMonth.order has June first)");
    assert.deepEqual([kharif.months[0]!.key, kharif.months.at(-1)!.key], ["2026-04", "2026-11"]);
    assert.equal(kharif.period, "Apr 2026 → Nov 2026", "the period text is the Seasons page's");
    assert.deepEqual(o.seasons[1]!.months.map((m) => m.name), ["November", "December", "January"], "another season has its own months, also in calendar order (Jan 2027 last)");
    assert.deepEqual(o.seasons.map((s) => s.eligibleCount), [2, 1], "approved Seasonal Plan markets per season (draft / pending / other seasons / other officers excluded)");
    assert.ok(plain(await service.getMonthlyOptions(ADMIN)).seasons[0]!.eligibleCount > 0, "Admin's dependency is the season's approved markets system-wide (Admin has no Seasonal Plan of their own)");

    const june = await sheetOf(service, SO1, "s-kharif", "sm-june");
    assert.deepEqual([june.seasonId, june.seasonName, june.monthLabel, june.status, june.itemCount, june.own], ["s-kharif", "Kharif 2026", "June 2026", "Draft", 0, true], "the plan stores the CHOSEN season + month; a new plan is an empty Draft");
    await sheetOf(service, SO1, "s-kharif", "sm-april"); await sheetOf(service, SO1, "s-rabi", "sm-r-nov");
    assert.deepEqual((await service.listMonthlySheets(SO1)).map((s) => s.monthLabel), ["November 2026", "June 2026", "April 2026"], "plans of different seasons AND months coexist in the list (newest month first)");
    assert.deepEqual(plain(await service.getMonthlyOptions(SO1)).seasons[0]!.takenMonthIds.sort(), ["sm-april", "sm-june"], "the dialog flags months that already have a plan");
    assert.equal(await status(() => service.createMonthlySheet(SO1, { seasonId: "s-kharif", seasonMonthId: "sm-june" })), 409, "one Monthly Plan per month");
    assert.equal(await status(() => service.createMonthlySheet(SO1, { seasonId: "s-kharif", seasonMonthId: "sm-r-nov" })), 422, "a month of ANOTHER season is refused");
    assert.equal(await status(() => service.createMonthlySheet(SO1, { seasonId: "s-kharif", seasonMonthId: "sm-december" })), 422, "a month outside the season is refused");
    assert.equal(await status(() => service.createMonthlySheet(SO1, { seasonId: "s-old", seasonMonthId: "sm-old-jun" })), 409, "a CLOSED season cannot be chosen");
    assert.equal(await status(() => service.createMonthlySheet(SO1, { seasonId: "nope", seasonMonthId: "sm-june" })), 422);
    assert.equal(await status(() => service.createMonthlySheet(SO1, { seasonId: "s-kharif" })), 422);
    assert.equal(await status(() => service.createMonthlySheet(SO3, { seasonId: "s-kharif", seasonMonthId: "sm-june" })), 422, "no approved Seasonal Plan market in that season → nothing to plan (the dialog explains it)");
    const adm = plain(await service.createMonthlySheet(ADMIN, { seasonId: "s-kharif", seasonMonthId: "sm-july" }));
    assert.deepEqual([adm.ownerId, adm.ownerName, adm.own, adm.status, adm.monthLabel], ["admin", "Admin", true, "Draft", "July 2026"], "Admin creates a Monthly Plan in their own right (no SO borrowed)");
    assert.equal(await status(() => service.createMonthlySheet(ADMIN, { seasonId: "s-kharif", seasonMonthId: "sm-july" })), 409, "one per month");
    assert.equal(await status(() => service.createMonthlySheet(ADMIN, { seasonId: "s-kharif", seasonMonthId: "sm-r-nov" })), 422, "Admin's month must belong to the chosen season");
    assert.equal(await status(() => service.createMonthlySheet({ ...ADMIN, role: Role.CUSTOM_ADMIN, permissions: {} } as unknown as AuthContext, { seasonId: "s-kharif", seasonMonthId: "sm-august" })), 403, "a custom admin without Party Planning manage cannot create");
    assert.ok((await service.listMonthlySheets(ADMIN)).some((s) => s.id === adm.id), "Admin's own plan appears in Admin's list");
    assert.equal(await status(() => service.getMonthlySheet(ADMIN, adm.id)), 0, "Admin opens their own plan");
    assert.equal(await status(() => service.getMonthlySheet(ADMIN, june.id)), 0, "Admin opens an officer's plan");
    assert.equal(await status(() => service.createMonthlyPlan(ADMIN, { sheetId: adm.id, seasonalPlanId: "sp-so1-new", option1Party: "P" })), 403, "rows stay SO/RM-owned");
    assert.ok((await service.listMonthlySheets(SO1)).every((s) => s.ownerId === "so1"), "an SO still sees only their own (not Admin's)");
    const spoof = plain(await service.createMonthlySheet(SO2, { seasonId: "s-kharif", seasonMonthId: "sm-july", ownerId: "so1", status: "Completed", itemCount: 5 }));
    assert.deepEqual([spoof.ownerId, spoof.status, spoof.itemCount], ["so2", "Draft", 0], "owner / status cannot be spoofed");
    const source = readFileSync("src/features/party-planning/monthly.server.ts", "utf8");
    assert.ok(!/getCurrentSeason|getCurrentOpenSeason|currentOpenSeason|currentBusinessDate\(\)\.slice/.test(source), "no 'current season / month' resolution");
    assert.equal(t.sheets.length, 5);
  }

  /* ---- open a Monthly Plan by id; add market rows from the approved Seasonal Plan ---- */
  {
    const { service, t } = loadService();
    const june = await sheetOf(service, SO1, "s-kharif", "sm-june");
    const d0 = plain(await service.getMonthlySheet(SO1, june.id));
    assert.deepEqual([d0.season.name, d0.month.label, d0.month.key, d0.plans.length], ["Kharif", "June 2026", "2026-06", 0], "the detail shows the plan's own season + month");
    assert.deepEqual(d0.seasonalPlans.map((p) => p.id).sort(), ["sp-so1", "sp-so1-new"], "the market choices = the caller's APPROVED Seasonal Plan rows of THIS plan's season");
    const plan = plain(await service.createMonthlyPlan(SO1, { sheetId: june.id, seasonalPlanId: "sp-so1", planDate: "2026-06-15", option1Party: "Party A", option2Party: "Party B" }));
    assert.deepEqual([plan.sheetId, plan.marketName, plan.marketPotential, plan.monthLabel, plan.planDate, plan.ownerId, plan.canManage], [june.id, "Pipariya", "B", "June 2026", "2026-06-15", "so1", true], "market + potential come from the Seasonal Plan's Market; the month from the plan");
    assert.deepEqual(plan.options.map((o) => [o.optionNo, o.partyName]), [[1, "Party A"], [2, "Party B"]], "Option 1 / 2 are candidate names only");
    assert.deepEqual([plan.opStatus, plan.statusLabel, plan.statusChangedAt, plan.allowedStatuses], ["NONE", "Draft", null, []], "a Draft plan shows Draft; no status actions yet");
    assert.deepEqual(plain(await service.getMonthlySheet(SO1, june.id)).seasonalPlans.map((p) => p.id), ["sp-so1-new"], "a market already used this month is no longer offered");
    // market dependency (server-side)
    for (const [label, body, code] of [
      ["a draft Seasonal Plan", { seasonalPlanId: "sp-so1-draft" }, 409], ["a Seasonal Plan awaiting approval", { seasonalPlanId: "sp-so1-pending" }, 409],
      ["a Seasonal Plan of another season", { seasonalPlanId: "sp-so1-rabi" }, 409], ["another officer's Seasonal Plan", { seasonalPlanId: "sp-so2" }, 404],
      ["an arbitrary Market id", { seasonalPlanId: "m-unseasonal" }, 404], ["a missing id", { seasonalPlanId: "nope" }, 404],
      ["a plan date outside the month", { seasonalPlanId: "sp-so1-new", planDate: "2026-07-01" }, 422], ["a garbage date", { seasonalPlanId: "sp-so1-new", planDate: "garbage" }, 422],
      ["no Option 1 party", { seasonalPlanId: "sp-so1-new", option1Party: "  " }, 422], ["the same market twice in a month", { seasonalPlanId: "sp-so1" }, 409],
    ] as [string, Row, number][]) assert.equal(await status(() => service.createMonthlyPlan(SO1, { sheetId: june.id, option1Party: "P", ...body })), code, label);
    assert.equal(await status(() => service.createMonthlyPlan(SO1, { seasonalPlanId: "sp-so1-new", option1Party: "P" })), 422, "a row needs its Monthly Plan (no implicit 'current month')");
    assert.equal(await status(() => service.createMonthlyPlan(SO2, { sheetId: june.id, seasonalPlanId: "sp-so2", option1Party: "P" })), 404, "another officer's plan cannot receive rows");
    assert.equal(await status(() => service.createMonthlyPlan(ADMIN, { sheetId: june.id, seasonalPlanId: "sp-so1-new", option1Party: "P" })), 403);
    // the SAME approved market can be planned in another month / another season's plan uses that season's markets
    const april = await sheetOf(service, SO1, "s-kharif", "sm-april");
    assert.equal(await status(() => service.createMonthlyPlan(SO1, { sheetId: april.id, seasonalPlanId: "sp-so1", planDate: "2026-04-10", option1Party: "April party" })), 0, "the same market in another month is fine");
    const rabi = await sheetOf(service, SO1, "s-rabi", "sm-r-nov");
    assert.deepEqual(plain(await service.getMonthlySheet(SO1, rabi.id)).seasonalPlans.map((p) => p.id), ["sp-so1-rabi"], "a Rabi plan offers Rabi's approved markets only");
    assert.equal(await status(() => service.createMonthlyPlan(SO1, { sheetId: rabi.id, seasonalPlanId: "sp-so1", option1Party: "P" })), 409, "a Kharif market cannot be planned in a Rabi plan");
    assert.equal(await status(() => service.createMonthlyPlan(SO1, { sheetId: rabi.id, seasonalPlanId: "sp-so1-rabi", planDate: "2026-11-20", option1Party: "R" })), 0);
    // spoofing: owner, market, potential, season, month, status are ignored
    const spoof = plain(await service.createMonthlyPlan(SO1, { sheetId: june.id, seasonalPlanId: "sp-so1-new", option1Party: "P", ownerId: "so2", marketId: "m-unseasonal", marketName: "Fake", marketPotential: "C", seasonId: "s-rabi", seasonMonthId: "sm-april", status: "APPOINTED", options: [{ optionNo: 1, status: "APPOINTED" }] }));
    assert.deepEqual([spoof.ownerId, spoof.marketId, spoof.marketName, spoof.marketPotential, spoof.seasonId, spoof.seasonMonthId, spoof.opStatus], ["so1", "m-new", "Bareli", "A", "s-kharif", "sm-june", "NONE"], "owner / market / potential / season / month / status cannot be spoofed");
    // list status follows the options
    assert.equal(plain((await service.listMonthlySheets(SO1)).find((s) => s.id === june.id)!).status, "In Progress");
    t.seasons.find((s) => s.id === "s-kharif")!.status = "CLOSED";
    assert.equal(await status(() => service.createMonthlyPlan(SO1, { sheetId: april.id, seasonalPlanId: "sp-so1-new", planDate: "2026-04-11", option1Party: "late" })), 409, "no new rows in a closed season");
    assert.equal(plain(await service.getMonthlySheet(SO1, june.id)).plans.length, 2, "…but its plans stay readable");
  }

  /* ---- row status workflow: ONE status per market row ---- */
  {
    const { service, t } = loadService();
    const plan = plain(await planFor(service));
    const row = () => plain(t.plans.find((p) => p.id === plan.id)!);
    assert.equal(t.options.filter((o) => o.monthlyPlanId === plan.id).length, 2, "Option 1 / 2 exist as names");
    assert.ok(!("status" in plan.options[0]!) && !("events" in plan.options[0]!), "options expose no status or timeline");
    // Not allowed until the PLAN is approved
    assert.equal(await status(() => move(service, SO1, plan, { to: "DOC_SENT", sent: { documents: true } }, { approve: false })), 409, "plan not approved → no status change");
    approveSheetOf(service, plan);
    assert.equal(plain(await service.getMonthlySheet(SO1, plan.sheetId)).plans[0]!.statusLabel, "Approved", "an approved plan shows Approved until the workflow starts");
    assert.deepEqual(plain(await service.getMonthlySheet(SO1, plan.sheetId)).plans[0]!.allowedStatuses.map((a) => a.label), ["Doc Send By SO"], "the SO may only choose Doc Send By SO");
    // SO: Doc Send By SO — validation
    assert.equal(await status(() => move(service, SO1, plan, { to: "DOC_SENT" })), 422, "needs the Document / Check selection");
    assert.equal(await status(() => move(service, SO1, plan, { to: "DOC_SENT", sent: { other: "only text" } })), 422, "Other alone is not enough: Document Sent or Check Send is required");
    assert.equal(await status(() => move(service, SO1, plan, { to: "DOC_SENT", sent: { documents: false, checks: false } })), 422);
    assert.equal(await status(() => move(service, SO1, plan, { to: "DOC_SENT", sent: { documents: true, other: "x".repeat(501) } })), 422);
    assert.equal(await status(() => move(service, ADMIN, plan, { to: "DOC_SENT", sent: { documents: true } })), 403, "Admin does not do the SO step");
    for (const [adminOnly, code] of [["DOC_RECEIVED", 409], ["SD_BOUNCE", 409], ["APPOINTED", 422], ["REJECTED", 403]] as const) assert.equal(await status(() => move(service, SO1, plan, { to: adminOnly, received: { documents: true }, remarks: "x" })), code, `the SO cannot set ${adminOnly}`);
    assert.equal(await status(() => move(service, SO1, plan, { to: "NONE" })), 422);
    assert.equal(await status(() => move(service, SO1, plan, { to: "BOGUS" })), 422);
    const before = row();
    assert.deepEqual([row().opStatus, t.statusEvents.length], ["NONE", 0], "refused attempts changed nothing");
    const sent = plain(await move(service, SO1, plan, { to: "DOC_SENT", sent: { documents: true, checks: false, other: "  GST  certificate " }, actorId: "admin", opStatus: "APPOINTED" }));
    assert.deepEqual([sent.opStatus, sent.statusLabel, sent.sentInfo, sent.receivedInfo], ["DOC_SENT", "Doc Send By SO", { documents: true, checks: false, other: "GST certificate" }, null], "saved exactly as the SO entered it; nothing inferred as received");
    const e1 = t.statusEvents[0]!;
    assert.deepEqual([e1.previousStatus, e1.newStatus, e1.actorId, e1.actorName, e1.actorRole, e1.createdAt instanceof Date], ["NONE", "DOC_SENT", "so1", "Officer One", "SALES_OFFICER", true], "actor + role + timestamp recorded server-side (spoofed fields ignored)");
    void before;
    // Conversion Date follows the status automatically
    const today = currentBusinessDate();
    assert.equal(sent.planDate, today, "Conversion Date = the date of the transition (Asia/Kolkata)");
    assert.equal(sent.dateHistory.at(-1)!.automatic, true); assert.equal(sent.dateHistory.at(-1)!.previousDate, "2026-06-15", "the previous date stays in the history");
    assert.equal(sent.dateChangeCount, 0, "automatic changes are not counted as the SO's manual edits");
    assert.equal(sent.canEditDate, false, "once the workflow has begun the date is no longer edited by hand");
    assert.equal(await status(() => service.updateMonthlyPlan(SO1, plan.id, { planDate: "2026-06-18" })), 409);
    assert.equal(await status(() => service.updateMonthlyPlan(SO1, plan.id, { option1Party: "switch" })), 409, "candidate names are frozen once the workflow has begun");
    // authorization along the way
    assert.equal(await status(() => move(service, SO1, plan, { to: "DOC_RECEIVED", received: { documents: true } })), 403, "the SO cannot record 'received'");
    assert.equal(await status(() => move(service, RM1, plan, { to: "DOC_RECEIVED", received: { documents: true } })), 403, "an RM cannot take the Admin step on a team plan");
    assert.equal(await status(() => move(service, SO2, plan, { to: "DOC_RECEIVED", received: { documents: true } })), 404, "another SO cannot even see it");
    assert.equal(await status(() => move(service, { ...ADMIN, role: Role.CUSTOM_ADMIN, permissions: {} } as unknown as AuthContext, plan, { to: "DOC_RECEIVED", received: { documents: true } })), 403, "a custom admin needs the Party Planning permission");
    assert.equal(await status(() => move(service, SO1, plan, { to: "DOC_SENT", sent: { documents: true } })), 409, "no repeating / jumping back");
    assert.equal(await status(() => appoint(service, ADMIN, plan)), 409, "Doc Send By SO → Appointed is not a valid move");
    assert.equal(await status(() => move(service, ADMIN, plan, { to: "APPOINTED" })), 422, "Appointed can only be set through the create-dealer step");
    // Admin: Doc Received — received kept SEPARATE from sent
    const admin1 = plain(await service.getMonthlySheet(ADMIN, plan.sheetId)).plans[0]!;
    assert.deepEqual(admin1.allowedStatuses.map((a) => a.to).sort(), ["DOC_RECEIVED", "REJECTED"], "Admin sees the Admin moves for a Doc Send By SO row");
    assert.deepEqual(admin1.sentInfo, sent.sentInfo, "the SO's submission is shown to Admin");
    assert.equal(await status(() => move(service, ADMIN, plan, { to: "DOC_RECEIVED", received: { documents: false, checks: false, other: "they said so" } })), 422, "nothing is assumed to be received");
    const got = plain(await move(service, ADMIN, plan, { to: "DOC_RECEIVED", received: { documents: false, checks: true, other: "Cheque only" } }));
    assert.deepEqual([got.opStatus, got.receivedInfo, got.sentInfo], ["DOC_RECEIVED", { documents: false, checks: true, other: "Cheque only" }, { documents: true, checks: false, other: "GST certificate" }], "received is stored separately; the SO's original submission is untouched");
    assert.equal(t.statusEvents[0]!.sentInfo.other, "GST certificate"); assert.equal(t.statusEvents[1]!.sentInfo, null);
    const e2 = t.statusEvents[1]!;
    assert.deepEqual([e2.previousStatus, e2.newStatus, e2.actorId, e2.actorName, e2.actorRole], ["DOC_SENT", "DOC_RECEIVED", "admin", "Admin", "SUPER_ADMIN"]);
    // other Admin statuses
    assert.equal(await status(() => move(service, SO1, plan, { to: "SD_BOUNCE" })), 403);
    const bounce = plain(await move(service, ADMIN, plan, { to: "SD_BOUNCE", remarks: "  Cheque returned " }));
    assert.deepEqual([bounce.opStatus, bounce.statusLabel, bounce.statusEvents.at(-1)!.remarks, bounce.planDate], ["SD_BOUNCE", "SD Bounce", "Cheque returned", today]);
    assert.equal(await status(() => move(service, ADMIN, plan, { to: "DOC_RECEIVED", received: { documents: true } })), 409, "no going back");
    assert.equal(await status(() => move(service, ADMIN, plan, { to: "SD_BOUNCE", remarks: "x".repeat(501) })), 422);
    const done = plain((await appoint(service, ADMIN, plan)) as Awaited<ReturnType<Svc["changeRowStatus"]>>);
    assert.deepEqual([done.opStatus, done.allowedStatuses.length, done.daysFinal], ["APPOINTED", 0, true], "Appointed is terminal and freezes Days");
    assert.equal(await status(() => move(service, ADMIN, plan, { to: "REJECTED", remarks: "late" })), 409, "Appointed is terminal");
    // the Seasonal Plan records the appointment (existing behaviour)
    assert.deepEqual([t.seasonalPlans.find((x) => x.id === "sp-so1")!.appointmentStatus, t.seasonalPlans.find((x) => x.id === "sp-so1")!.appointedAt instanceof Date], ["APPOINTED", true]);
    // append-only: full ordered history, one record per transition
    const history = plain(await service.getMonthlySheet(SO1, plan.sheetId)).plans[0]!.statusEvents;
    assert.deepEqual(history.map((e) => [e.previousStatus, e.newStatus]), [["NONE", "DOC_SENT"], ["DOC_SENT", "DOC_RECEIVED"], ["DOC_RECEIVED", "SD_BOUNCE"], ["SD_BOUNCE", "APPOINTED"]]);
    assert.ok(history.every((e) => !Number.isNaN(Date.parse(e.createdAt))) && history.every((e, i) => i === 0 || e.createdAt >= history[i - 1]!.createdAt));
    assert.equal(row().opStatus, "APPOINTED");
    const src = readFileSync("src/features/party-planning/monthly.server.ts", "utf8");
    assert.ok(!/partyMonthlyStatusEvent\.(update|delete|upsert)/.test(src) && !/transitionOption|setConversionDate/.test(src), "history is insert-only; the per-option workflow and manual Admin date confirmation are gone");
    assert.ok(readFileSync("prisma/migrations/20261009000000_monthly_row_status/migration.sql", "utf8").includes("PartyMonthlyStatusEvent_no_delete"));
    // Rejected path + Admin rejection from the start; remarks optional
    const r2 = await planFor(service, { seasonalPlanId: "sp-so1-new", seasonMonthId: "sm-july", planDate: "2026-07-20" });
    assert.equal(plain(await move(service, ADMIN, r2, { to: "REJECTED" })).statusLabel, "Rejected", "Admin may reject an approved plan's row; remarks are optional");
    assert.equal(await status(() => move(service, SO1, r2, { to: "DOC_SENT", sent: { documents: true } })), 409);
  }

  /* ---- Appointed = create the Dealer (Dealer Alias service) + mark the row, atomically ---- */
  {
    const { service, t } = loadService();
    const plan = plain(await planFor(service));
    approveSheetOf(service, plan);
    await move(service, SO1, plan, { to: "DOC_SENT", sent: { documents: true } });
    await move(service, ADMIN, plan, { to: "DOC_RECEIVED", received: { documents: true } });
    const snapshot = () => JSON.stringify([t.plans.map((p) => [p.id, p.opStatus, p.appointedDealerId, p.planDate]), t.statusEvents.length, t.dateChanges.length, t.dealers.length, t.audit.length]);
    const before = snapshot();
    // authorization — nothing is created for anyone but an authorized Admin
    assert.equal(await status(() => appoint(service, SO1, plan)), 403, "the SO cannot appoint / create a dealer");
    assert.equal(await status(() => appoint(service, RM1, plan)), 403, "nor an RM");
    assert.equal(await status(() => appoint(service, SO2, plan)), 403, "nor another officer (no dealer-creation permission is granted by this feature)");
    assert.equal(await status(() => appoint(service, { ...ADMIN, role: Role.CUSTOM_ADMIN, permissions: { partyPlanning: ["read", "approve"] } } as unknown as AuthContext, plan)), 403, "a custom admin also needs the Dealers create permission (as POST /api/dealers does)");
    assert.equal(await status(() => appoint(service, { ...ADMIN, role: Role.CUSTOM_ADMIN, permissions: { dealers: ["read", "create"] } } as unknown as AuthContext, plan)), 403, "…and the Party Planning approve permission");
    assert.equal(await status(() => appoint(service, ADMIN, plan, { dealer: undefined })), 422, "dealer details are required");
    assert.equal(await status(() => appoint(service, ADMIN, plan, { remarks: "x".repeat(501) })), 422);
    assert.equal(snapshot(), before, "refused attempts changed / created nothing");
    assert.equal(t.dealerCalls.length, 0, "the dealer service was never reached by unauthorized callers");
    // plan must be approved
    TABLES.get(service)!.plans.find((x) => x.id === plan.id)!.approvalStatus = "PENDING_ADMIN"; // submitted, not yet approved
    assert.equal(await status(() => appoint(service, ADMIN, plan, {}, { approve: false })), 409);
    // backend failure (e.g. duplicate alias) → NOT appointed, nothing left behind, can be retried
    t.failDealer = true;
    assert.equal(await status(() => appoint(service, ADMIN, plan)), 409, "a dealer-creation error is reported");
    assert.equal(snapshot(), before, "…and the row keeps its previous status (no event, no dealer, no date change)");
    // a similar dealer exists → warning, nothing saved (this is the existing Create Dealer duplicate step)
    t.dealers.push({ id: "old", name: "ABC Traders" });
    const dup = plain(await appoint(service, ADMIN, plan)) as unknown as { duplicates: { name: string }[] };
    assert.equal(dup.duplicates[0]!.name, "Existing dealer");
    assert.equal(t.plans.find((p) => p.id === plan.id)!.opStatus, "DOC_RECEIVED", "a duplicate warning does not appoint");
    assert.equal(t.dealers.length, 1);
    // success (force, as the dialog's "Create anyway")
    t.dealerCalls.length = 0;
    const ok = plain((await appoint(service, ADMIN, plan, { remarks: " welcome ", dealer: { ...DEALER, force: true } })) as Awaited<ReturnType<Svc["changeRowStatus"]>>);
    assert.deepEqual([ok.opStatus, ok.statusLabel, ok.daysFinal, ok.allowedStatuses.length, ok.planDate], ["APPOINTED", "Appointed", true, 0, currentBusinessDate()]);
    assert.equal(t.dealers.length, 2);
    const created = t.dealers[1]!;
    assert.deepEqual([created.name, created.officerId, created.groupId, created.aliasName, created.town, created.addToSeasonalPlan], ["ABC Traders", "so1", "g1", "ABC TRADERS (TALLY)", "Pipariya", true], "dealer created with the form's officer, group, alias, territory and seasonal-plan choice");
    assert.equal(t.dealerCalls[0]!.usedCallerTx, true, "created inside the SAME transaction as the status change");
    assert.equal(t.dealerCalls[0]!.ctx.userId, "admin");
    assert.deepEqual([ok.appointedDealerId, ok.appointedDealerName], [created.id, "ABC Traders"], "the row references the created dealer");
    const ev = t.statusEvents.at(-1)!;
    assert.deepEqual([ev.previousStatus, ev.newStatus, ev.dealerId, ev.actorId, ev.actorRole, ev.remarks, ev.createdAt instanceof Date], ["DOC_RECEIVED", "APPOINTED", created.id, "admin", "SUPER_ADMIN", "welcome", true], "history: transition, acting Admin, time and the dealer reference");
    assert.equal(t.dateChanges.at(-1)!.automatic, true);
    assert.deepEqual([t.seasonalPlans.find((x) => x.id === "sp-so1")!.appointmentStatus], ["APPOINTED"], "existing Seasonal appointment bookkeeping still happens");
    // no duplicate dealers on retry / double submit
    assert.equal(await status(() => appoint(service, ADMIN, plan, { dealer: { ...DEALER, force: true } })), 409, "a second submission is refused…");
    assert.equal(t.dealers.length, 2, "…and creates no second dealer");
    // a lost race: another request wins between our read and our claim → our dealer is rolled back
    const plan2 = plain(await planFor(service, { seasonalPlanId: "sp-so1-new", seasonMonthId: "sm-july", planDate: "2026-07-20" }));
    approveSheetOf(service, plan2);
    await move(service, SO1, plan2, { to: "DOC_SENT", sent: { checks: true } }); await move(service, ADMIN, plan2, { to: "DOC_RECEIVED", received: { checks: true } });
    const race = t.plans.find((p) => p.id === plan2.id)!;
    t.onClaim = () => { race.opStatus = "REJECTED"; };
    const dealersBefore = t.dealers.length;
    assert.equal(await status(() => appoint(service, ADMIN, plan2, { dealer: { ...DEALER, name: "Race Co", force: true } })), 409);
    assert.equal(t.dealers.length, dealersBefore, "no orphan dealer after a lost race");
    // wiring
    const src = readFileSync("src/features/party-planning/monthly.server.ts", "utf8");
    assert.ok(src.includes("createDealerForOfficer(ctx, r.dealer, { tx })") && !/tx\.dealer\.create/.test(src), "the existing Dealer Alias service creates the dealer; Party Planning inserts no dealer / seasonal / recovery records itself");
    assert.ok(readFileSync("prisma/migrations/20261009010000_monthly_appointed_dealer/migration.sql", "utf8").includes("appointedDealerId"));
    assert.ok(readFileSync("src/features/accounts/route-permissions.ts", "utf8").includes('p.endsWith("/appoint")'));
  }

  /* ---- candidate party edits, atomicity, concurrency ---- */
  {
    const { service, t } = loadService();
    const plan = plain(await planFor(service));
    const renamed = plain(await service.updateMonthlyPlan(SO1, plan.id, { option2Party: "New B", planDate: "2026-06-20", ownerId: "so2", opStatus: "APPOINTED" }));
    assert.deepEqual([renamed.options[1]!.partyName, renamed.planDate, renamed.ownerId, renamed.opStatus, renamed.dateChangeCount], ["New B", "2026-06-20", "so1", "NONE", 1], "name + date edits work before the workflow; status cannot be spoofed");
    assert.equal(await status(() => service.updateMonthlyPlan(SO1, plan.id, { planDate: "2026-07-20" })), 422, "plan date stays inside the month");
    assert.equal(await status(() => service.updateMonthlyPlan(SO2, plan.id, { planDate: "2026-06-20" })), 404);
    const fresh = await planFor(service, { seasonalPlanId: "sp-so1-new" });
    const snapshot = JSON.stringify([t.plans.map((p) => [p.id, p.opStatus, p.planDate]), t.statusEvents.length, t.dateChanges.length]);
    t.failNextEvent = true;
    assert.equal(await status(() => move(service, SO1, fresh, { to: "DOC_SENT", sent: { documents: true } })), -1);
    assert.equal(JSON.stringify([t.plans.map((p) => [p.id, p.opStatus, p.planDate]), t.statusEvents.length, t.dateChanges.length]), snapshot, "status, Conversion Date and history stay consistent: all or nothing");
    const racing = await planFor(service, { seasonalPlanId: "sp-so1-new", seasonMonthId: "sm-july", planDate: "2026-07-10" });
    approveSheetOf(service, racing);
    const claim = t.plans.find((p) => p.id === racing.id)!;
    t.onClaim = () => { claim.opStatus = "DOC_SENT"; }; // someone else moves the row after we read it, right before our claim
    assert.equal(await status(() => service.changeRowStatus(SO1, racing.id, { to: "DOC_SENT", sent: { documents: true } })), 409, "a stale read is refused");
    assert.equal(t.statusEvents.length, 0, "and no event was appended");
  }

  /* ---- persistent Create workspace; Submitted / Approved ACCUMULATE entries of one logical plan ---- */
  {
    const { service, t } = loadService();
    const stageOf = async (ctx: AuthContext, stage: "create" | "submitted" | "approved" | "older") => ids(await service.listMonthlySheets(ctx, { stage }));
    const so = await sheetOf(service, SO1, "s-kharif", "sm-june");
    const row = (id: string) => t.plans.find((p) => p.id === id)!;
    const add = (sp: string, extra: Row = {}) => service.createMonthlyPlan(SO1, { sheetId: so.id, seasonalPlanId: sp, planDate: "2026-06-15", option1Party: `Party ${sp}`, ...extra });
    // 1) the workspace exists from creation and is the ONLY plan for this owner + month
    assert.deepEqual([so.counts.create, so.counts.submitted, so.counts.approved, so.canEdit, so.canSubmit], [0, 0, 0, true, false], "a new plan: an empty, editable workspace");
    assert.deepEqual([await stageOf(SO1, "create"), await stageOf(SO1, "submitted"), await stageOf(SO1, "approved")], [[so.id], [], []]);
    assert.equal(await status(() => service.createMonthlySheet(SO1, { seasonId: "s-kharif", seasonMonthId: "sm-june" })), 409, "no second workspace for the same owner + month");
    assert.equal(await status(() => service.submitMonthlySheet(SO1, so.id)), 409, "nothing to submit yet");
    // 2) first batch
    const a = plain(await add("sp-so1"));
    assert.equal(plain((await service.getMonthlySheet(SO1, so.id)).sheet).canSubmit, true);
    for (const who of [SO2, RM1, ADMIN]) assert.ok([403, 404].includes(await status(() => service.submitMonthlySheet(who, so.id))), "only the owner submits");
    const s1 = plain(await service.submitMonthlySheet(SO1, so.id));
    assert.deepEqual([s1.counts.create, s1.counts.submitted, s1.counts.approved, s1.canSubmit, s1.canEdit], [0, 1, 0, false, true], "the batch left the editable workspace; the workspace stays open for more");
    assert.equal(row(a.id).approvalStatus, "PENDING_RM", "an SO with an RM goes to RM review — NOT approved by submitting");
    assert.deepEqual([await stageOf(SO1, "create"), await stageOf(SO1, "submitted"), await stageOf(SO1, "approved")], [[so.id], [so.id], []], "Create still lists the plan, Submitted now lists it too — still ONE plan");
    const stamp = row(a.id).submittedAt;
    // views per section
    const view = async (ctx: AuthContext, stage: string) => plain(await service.getMonthlySheet(ctx, so.id, stage)).plans.map((p) => p.id);
    assert.deepEqual([await view(SO1, "create"), await view(SO1, "submitted"), await view(SO1, "approved")], [[], [a.id], []], "each section shows only its own entries");
    assert.equal(plain(await service.getMonthlySheet(SO1, so.id, "create")).seasonalPlans.map((p) => p.id).join(), "sp-so1-new", "the market already planned is not offered again");
    // a concurrent change between our read and our claim: the entry is not submitted twice (the claim loses)
    {
      const racer = plain(await add("sp-so1-new")); // (planned, then removed from the batch below by the competing change)
      t.onClaim = () => { row(racer.id).approvalStatus = "PENDING_ADMIN"; };
      assert.equal(await status(() => service.submitMonthlySheet(SO1, so.id)), 409, "a lost claim submits nothing");
      row(racer.id).approvalStatus = "DRAFT"; t.plans.splice(t.plans.findIndex((p) => p.id === racer.id), 1);
    }
    // 3) second batch accumulates in the SAME plan; earlier entry untouched; retry duplicates nothing
    const b = plain(await add("sp-so1-new"));
    assert.equal(await status(() => add("sp-so1-new")), 409, "the same market cannot be added twice for the month");
    assert.equal(await status(() => service.updateMonthlyPlan(SO1, a.id, { option1Party: "rewrite history" })), 409, "a submitted entry can no longer be edited");
    const s2 = plain(await service.submitMonthlySheet(SO1, so.id));
    assert.deepEqual([s2.counts.create, s2.counts.submitted], [0, 2]);
    assert.equal(String(row(a.id).submittedAt), String(stamp), "the earlier entry keeps its own submission record");
    assert.equal(await status(() => service.submitMonthlySheet(SO1, so.id)), 409, "a retry / double click submits nothing twice");
    assert.deepEqual(await view(SO1, "submitted"), [a.id, b.id].sort((x, y) => plain(row(x).marketNameAtPlanning).localeCompare(row(y).marketNameAtPlanning)));
    assert.equal(t.sheets.length, 1, "still one logical plan"); assert.equal(t.plans.length, 2, "entries keep their identity (no copies)");
    // 4) review as a batch; RM first, then Admin
    assert.equal(await status(() => service.actOnMonthlySheet(SO1, so.id, { action: "approve" })), 403, "an SO cannot approve");
    assert.equal(await status(() => service.actOnMonthlySheet(ADMIN, so.id, { action: "approve" })), 409, "Admin cannot skip the RM step");
    assert.equal(await status(() => service.actOnMonthlySheet(RM1, so.id, { action: "reject", reason: " " })), 422, "a rejection needs a reason");
    assert.equal(plain(await service.getMonthlySheet(RM1, so.id)).sheet.canReview, true);
    assert.equal(plain(await service.getMonthlySheet(ADMIN, so.id)).sheet.canReview, false, "Admin acts only after the RM step");
    const rmOk = plain(await service.actOnMonthlySheet(RM1, so.id, { action: "approve" }));
    assert.deepEqual([row(a.id).approvalStatus, row(b.id).approvalStatus, rmOk.counts.submitted, rmOk.counts.approved], ["PENDING_ADMIN", "PENDING_ADMIN", 2, 0], "RM approval is not final");
    assert.equal(await status(() => service.actOnMonthlySheet(RM1, so.id, { action: "approve" })), 409, "no double approval");
    assert.deepEqual(await stageOf(SO1, "approved"), [], "nothing is in Approved before the real approval");
    assert.equal(await status(() => service.actOnMonthlySheet({ ...ADMIN, role: Role.CUSTOM_ADMIN, permissions: {} } as unknown as AuthContext, so.id, { action: "approve" })), 403);
    const done = plain(await service.actOnMonthlySheet(ADMIN, so.id, { action: "approve" }));
    assert.deepEqual([done.counts.submitted, done.counts.approved, row(a.id).approvalStatus, row(b.id).approvalStatus], [0, 2, "APPROVED", "APPROVED"]);
    assert.equal(await status(() => service.actOnMonthlySheet(ADMIN, so.id, { action: "approve" })), 409, "an approval retry duplicates / re-approves nothing");
    assert.deepEqual([await stageOf(SO1, "create"), await stageOf(SO1, "submitted"), await stageOf(SO1, "approved"), await stageOf(RM1, "approved"), await stageOf(ADMIN, "approved")], [[so.id], [], [so.id], [so.id], [so.id]], "Approved lists the one logical plan");
    const decided = row(a.id).adminDecidedAt;
    // 5) a LATER batch accumulates in Approved; it is NOT auto-approved just because the plan has approved entries
    // (the two Kharif markets are used in June, so the next batches are planned in July — the same logic, another month)
    const july = await sheetOf(service, SO1, "s-kharif", "sm-july");
    const d1 = plain(await service.createMonthlyPlan(SO1, { sheetId: july.id, seasonalPlanId: "sp-so1", planDate: "2026-07-10", option1Party: "July A" }));
    await service.submitMonthlySheet(SO1, july.id);
    const d2 = plain(await service.createMonthlyPlan(SO1, { sheetId: july.id, seasonalPlanId: "sp-so1-new", planDate: "2026-07-11", option1Party: "July B" }));
    assert.equal(row(d1.id).approvalStatus, "PENDING_RM", "July: first batch awaits review");
    await service.actOnMonthlySheet(RM1, july.id, { action: "approve" }); await service.actOnMonthlySheet(ADMIN, july.id, { action: "approve" });
    assert.deepEqual([row(d1.id).approvalStatus, row(d2.id).approvalStatus], ["APPROVED", "DRAFT"], "the new, unsubmitted entry is not approved just because earlier ones were");
    await service.submitMonthlySheet(SO1, july.id);
    assert.equal(row(d2.id).approvalStatus, "PENDING_RM", "…it goes through the normal approval path");
    const approvedAt = row(d1.id).adminDecidedAt;
    await service.actOnMonthlySheet(RM1, july.id, { action: "approve" }); const julyDone = plain(await service.actOnMonthlySheet(ADMIN, july.id, { action: "approve" }));
    assert.deepEqual([julyDone.counts.approved, julyDone.counts.submitted, String(row(d1.id).adminDecidedAt) === String(approvedAt)], [2, 0, true], "the later batch is appended; the earlier approved entry is unchanged");
    assert.equal(t.sheets.filter((x) => x.seasonMonthId === "sm-july" && x.ownerId === "so1").length, 1, "one Approved plan for the month");
    assert.equal(String(row(a.id).adminDecidedAt), String(decided), "earlier approved entries are untouched");
  }

  /* ---- rejection returns only the rejected batch to Create ---- */
  {
    const { service, t } = loadService();
    const so = await sheetOf(service, SO1, "s-kharif", "sm-june");
    const row = (id: string) => t.plans.find((p) => p.id === id)!;
    const a = await service.createMonthlyPlan(SO1, { sheetId: so.id, seasonalPlanId: "sp-so1", planDate: "2026-06-15", option1Party: "A" });
    await service.submitMonthlySheet(SO1, so.id); await service.actOnMonthlySheet(RM1, so.id, { action: "approve" }); await service.actOnMonthlySheet(ADMIN, so.id, { action: "approve" });
    const b = await service.createMonthlyPlan(SO1, { sheetId: so.id, seasonalPlanId: "sp-so1-new", planDate: "2026-06-16", option1Party: "B" });
    await service.submitMonthlySheet(SO1, so.id);
    const rej = plain(await service.actOnMonthlySheet(RM1, so.id, { action: "reject", reason: "Wrong party" }));
    assert.deepEqual([row(a.id).approvalStatus, row(b.id).approvalStatus, rej.counts.approved, rej.counts.rejected, rej.counts.create, rej.counts.submitted], ["APPROVED", "REJECTED", 1, 1, 1, 0], "only the rejected entry is rejected; it is NOT shown as approved");
    const view = plain(await service.getMonthlySheet(SO1, so.id, "create"));
    assert.deepEqual([view.plans.map((p) => p.id), view.plans[0]!.rejectionReason, view.plans[0]!.canEditEntry, view.sheet.rejectionReason], [[b.id], "Wrong party", true, "Wrong party"], "back in Create, editable, with the reason");
    assert.deepEqual(plain(await service.getMonthlySheet(SO1, so.id, "approved")).plans.map((p) => p.id), [a.id], "the approved entry stays in Approved");
    await service.updateMonthlyPlan(SO1, b.id, { option1Party: "B fixed" });
    assert.equal(plain(await service.submitMonthlySheet(SO1, so.id)).counts.submitted, 1, "resubmitted through the same path");
    assert.equal(row(b.id).rejectionReason, null);
    // status workflow needs an APPROVED entry, not an approved plan
    assert.equal(await status(() => move(service, SO1, b, { to: "DOC_SENT", sent: { documents: true } }, { approve: false })), 409, "a submitted entry cannot start the status workflow");
    assert.equal(plain(await move(service, SO1, a, { to: "DOC_SENT", sent: { documents: true } }, { approve: false })).opStatus, "DOC_SENT", "an approved entry can");
    // isolation
    assert.ok([403, 404].includes(await status(() => service.actOnMonthlySheet(SO2, so.id, { action: "approve" }))));
    assert.equal(await status(() => service.getMonthlySheet(SO2, so.id)), 404, "another officer cannot open it");
    assert.ok([403, 404].includes(await status(() => service.submitMonthlySheet(SO2, so.id))));
    // Older Plans: closed season, nothing altered
    const snapshot = JSON.stringify([t.sheets, t.plans.map((p) => [p.id, p.approvalStatus, p.opStatus])]);
    t.seasons.find((x) => x.id === "s-kharif")!.status = "CLOSED";
    assert.deepEqual([ids(await service.listMonthlySheets(SO1, { stage: "create" })), ids(await service.listMonthlySheets(SO1, { stage: "approved" })), ids(await service.listMonthlySheets(SO1, { stage: "older" }))], [[], [], [so.id]]);
    assert.equal(JSON.stringify([t.sheets, t.plans.map((p) => [p.id, p.approvalStatus, p.opStatus])]), snapshot, "classification alters no record");
    const older = plain(await service.getMonthlySheet(SO1, so.id, "older"));
    assert.deepEqual([older.plans.length, older.sheet.canEdit, older.sheet.canSubmit, older.sheet.canReview], [2, false, false, false], "historical plans load and are read-only");
    assert.equal(await status(() => service.submitMonthlySheet(SO1, so.id)), 409);
  }

  /* ---- Admin-created plans are in the global lists ---- */
  {
    const { service } = loadService();
    const adm = plain(await service.createMonthlySheet(ADMIN, { seasonId: "s-kharif", seasonMonthId: "sm-july" }));
    assert.deepEqual([adm.canEdit, adm.own], [true, true]);
    assert.ok(ids(await service.listMonthlySheets(ADMIN, { stage: "create" })).includes(adm.id), "Admin sees their own plan in Create");
    assert.equal(await status(() => service.submitMonthlySheet(ADMIN, adm.id)), 403, "submission stays SO/RM (Admin has no Seasonal market rows of their own)");
    const so = await sheetOf(service, SO1);
    assert.ok(ids(await service.listMonthlySheets(ADMIN, { stage: "create" })).includes(so.id), "…and every officer's workspace");
    assert.deepEqual(ids(await service.listMonthlySheets(SO1, { stage: "create" })), [so.id], "an SO still sees only their own");
    assert.ok(!ids(await service.listMonthlySheets(RM1, { stage: "create" })).includes(adm.id), "an RM does not see the Admin's plan");
  }

  /* ---- Conversion Date: SO edits + counter before the workflow; automatic after; Days freeze at Appointed ---- */
  {
    const { service, t } = loadService();
    const DAY = 86_400_000;
    t.seasonalPlans.find((x) => x.id === "sp-so1")!.createdAt = new Date("2026-06-15T06:00:00.000Z"); // added to Seasonal Planning on 15 Jun (IST)
    const plan = plain(await planFor(service, { planDate: null }));
    assert.deepEqual([plan.planDate, plan.dateChangeCount, plan.canEditDate], [null, 0, true]);
    assert.equal(plan.seasonalAddedOn, "2026-06-15", "Days start at the Seasonal Plan added date, in Asia/Kolkata");
    assert.deepEqual([plan.daysFinal, plan.days > 0], [false, true], "live aging");
    // before the workflow: exactly the old behaviour
    const edit = (d: string) => service.updateMonthlyPlan(SO1, plan.id, { planDate: d });
    let cur = plain(await edit("2026-06-20")); cur = plain(await edit("2026-06-22")); cur = plain(await edit("2026-06-25"));
    assert.equal(cur.dateChangeCount, 3, "every hand edit is counted");
    assert.equal(plain(await edit("2026-06-25")).dateChangeCount, 3, "saving the same date is not a change");
    assert.deepEqual(cur.dateHistory.map((c) => [c.previousDate, c.newDate, c.byAdmin, c.automatic]), [[null, "2026-06-20", false, false], ["2026-06-20", "2026-06-22", false, false], ["2026-06-22", "2026-06-25", false, false]]);
    assert.equal(cur.daysFinal, false);
    // the manual Admin confirmation workflow is gone
    assert.ok(!("adminConfirmed" in cur) && !("canConfirmDate" in cur) && !("setConversionDate" in service));
    approveSheetOf(service, plan);
    // after the first status change the date follows the status automatically and old history is kept
    const sent = plain(await move(service, SO1, plan, { to: "DOC_SENT", sent: { documents: true } }));
    const today = currentBusinessDate();
    assert.deepEqual([sent.planDate, sent.dateChangeCount, sent.dateHistory.length, sent.dateHistory.at(-1)!.automatic, sent.dateHistory.at(-1)!.previousDate], [today, 3, 4, true, "2026-06-25"], "Conversion Date = transition date; the 3 manual edits and their history are preserved");
    assert.equal(sent.daysFinal, false, "Days keep counting until Appointed");
    // repeated transitions keep the date current while preserving each previous value
    t.plans.find((p) => p.id === plan.id)!.planDate = new Date("2026-06-26T00:00:00.000Z"); // pretend the previous transition happened earlier
    const got = plain(await move(service, ADMIN, plan, { to: "DOC_RECEIVED", received: { checks: true } }));
    assert.deepEqual([got.planDate, got.dateHistory.at(-1)!.previousDate, got.dateHistory.at(-1)!.byAdmin, got.dateHistory.at(-1)!.automatic], [today, "2026-06-26", true, true]);
    assert.equal(got.statusEvents.length, 2);
    // Days freeze at the Appointed date
    t.seasonalPlans.find((x) => x.id === "sp-so1")!.createdAt = new Date(Date.now() - 30 * DAY);
    const live = plain(await service.getMonthlySheet(ADMIN, plan.sheetId)).plans[0]!;
    assert.deepEqual([live.daysFinal, live.days], [false, Math.round((Date.parse(today) - Date.parse(live.seasonalAddedOn)) / DAY)], "before Appointed: seasonal added → today");
    const appointed = plain((await appoint(service, ADMIN, plan)) as Awaited<ReturnType<Svc["changeRowStatus"]>>);
    assert.deepEqual([appointed.daysFinal, appointed.days], [true, Math.round((Date.parse(appointed.planDate!) - Date.parse(appointed.seasonalAddedOn)) / DAY)], "at Appointed: seasonal added → appointment date");
    t.plans.find((p) => p.id === plan.id)!.planDate = new Date(Date.parse(today) - 0); // (the stored date is the appointment date; "today" moving on must not change Days)
    // Days never use the Monthly row's creation date
    const fresh = loadService();
    fresh.t.seasonalPlans.find((x) => x.id === "sp-so1")!.createdAt = new Date(Date.now() - 400 * DAY);
    const fp = plain(await planFor(fresh.service, { planDate: null }));
    assert.ok(fp.days >= 399, "the Seasonal added date drives Days, not the (just created) Monthly row");
    // visibility / authorization of the date
    assert.equal(await status(() => service.getMonthlySheet(SO2, plan.sheetId)), 404);
    assert.equal(await status(() => service.updateMonthlyPlan(SO2, plan.id, { planDate: "2026-06-10" })), 404, "another SO cannot change the date");
    assert.equal(await status(() => service.updateMonthlyPlan(ADMIN, plan.id, { planDate: "2026-06-10" })), 403, "Admin does not hand-edit the date either");
    t.seasons.find((x) => x.id === "s-kharif")!.status = "CLOSED";
    assert.equal(await status(() => move(service, ADMIN, plan, { to: "REJECTED" })), 409, "closed season: read-only");
    assert.ok(readFileSync("prisma/migrations/20261008020000_monthly_conversion_date_history/migration.sql", "utf8").includes("PartyMonthlyDateChange_no_delete"));
  }

  /* ---- scope + authorization + list filters ---- */
  {
    const { service } = loadService();
    const so1Plan = await planFor(service);
    await planFor(service, { seasonalPlanId: "sp-so2", seasonMonthId: "sm-july", planDate: "2026-07-05" }, SO2);
    const rmPlan = await planFor(service, { seasonalPlanId: "sp-rm1", seasonMonthId: "sm-august", planDate: "2026-08-05" }, RM1);
    const sheetIds = async (ctx: AuthContext) => ids(await service.listMonthlySheets(ctx));
    assert.equal((await service.listMonthlySheets(SO1)).length, 1, "an SO sees their own plans only");
    assert.equal((await service.listMonthlySheets(RM1)).length, 3, "an RM: their own + the whole team");
    assert.equal((await service.listMonthlySheets(SO3)).length, 0, "another group's officer sees none of them");
    assert.equal((await service.listMonthlySheets(ADMIN)).length, 3, "Admin sees all");
    const so2Sheet = (await service.listMonthlySheets(SO2))[0]!;
    assert.equal(await status(() => service.getMonthlySheet(SO1, so2Sheet.id)), 404, "another officer's plan cannot be opened by id");
    assert.equal(await status(() => service.getMonthlySheet(SO3, so2Sheet.id)), 404);
    assert.equal(await status(() => service.getMonthlySheet(RM1, so2Sheet.id)), 0, "the team's RM may open it (read-only)");
    assert.equal(plain(await service.getMonthlySheet(RM1, so2Sheet.id)).plans[0]!.canManage, false);
    assert.equal(await status(() => service.getMonthlySheet(ADMIN, so2Sheet.id)), 0);
    assert.equal(await status(() => move(service, SO2, so1Plan, { to: "DOC_SENT", sent: DOCS })), 404, "an SO cannot touch another SO's plan by id");
    assert.equal(await status(() => move(service, RM1, so1Plan, { to: "DOC_SENT", sent: DOCS })), 403, "an RM can see but not act on a team member's plan");
    assert.equal(await status(() => move(service, RM1, rmPlan, { to: "DOC_SENT", sent: DOCS })), 0, "an RM plans their OWN markets like an SO");
    assert.equal(await status(() => move(service, RM1, rmPlan, { to: "DOC_RECEIVED", received: DOCS })), 403, "…but cannot do the Admin step");
    assert.equal(await status(() => move(service, ADMIN, so1Plan, { to: "DOC_SENT", sent: DOCS })), 403, "Admin does not do the owner step");
    assert.equal(await status(() => move(service, { ...SO1, role: undefined } as unknown as AuthContext, so1Plan, { to: "DOC_SENT", sent: DOCS })), 403, "unknown role");
    // Filters: by season, and "needs my action" (Admin: waiting on Admin; owner: still Pending).
    assert.equal((await service.listMonthlySheets(ADMIN, { seasonId: "s-rabi" })).length, 0);
    assert.equal((await service.listMonthlySheets(ADMIN, { seasonId: "s-kharif" })).length, 3);
    assert.deepEqual(ids(await service.listMonthlySheets(ADMIN, { needsAction: true })), [(await service.listMonthlySheets(RM1)).find((s) => s.own)!.id], "only the plan with a Doc Sent option waits on Admin");
    assert.equal((await service.listMonthlySheets(SO1, { needsAction: true })).length, 1, "the owner's plan still has Pending options to send");
    void sheetIds;
    // Within one plan (approved): allowed moves by role.
    approveSheetOf(service, so1Plan);
    const sheetId = (await service.listMonthlySheets(SO1))[0]!.id;
    assert.deepEqual(plain(await service.getMonthlySheet(SO1, sheetId)).plans[0]!.allowedStatuses.map((a) => a.to), ["DOC_SENT"]);
    assert.deepEqual(plain(await service.getMonthlySheet(ADMIN, sheetId)).plans[0]!.allowedStatuses.map((a) => a.to), ["REJECTED"], "Admin may reject but not send documents");
    assert.deepEqual(plain(await service.getMonthlySheet(RM1, sheetId)).plans[0]!.allowedStatuses, [], "an RM viewing a team plan has no status actions");
  }

  /* ---- a closed season keeps history but is read-only ---- */
  {
    const { service, t } = loadService();
    const plan = await planFor(service);
    await move(service, SO1, plan, { to: "DOC_SENT", sent: DOCS });
    t.seasons.find((s) => s.id === "s-kharif")!.status = "CLOSED";
    assert.equal(await status(() => move(service, ADMIN, plan, { to: "DOC_RECEIVED", received: DOCS })), 409, "a plan of a closed season is read-only");
    assert.equal(await status(() => service.updateMonthlyPlan(SO1, plan.id, { planDate: "2026-06-18" })), 409);
    assert.equal(t.plans.length, 1);
    assert.equal(t.statusEvents.filter((e) => e.monthlyPlanId === plan.id).length, 1, "history is never deleted");
    assert.deepEqual(plain(await service.getMonthlySheet(SO1, plan.sheetId)).plans[0]!.allowedStatuses, [], "no actions are offered");
  }

  /* ---- detail page wiring: Market | Party Options | Status | Conversion Date | Days ---- */
  {
    const ui = readFileSync("src/features/party-planning/monthly-planning-page.tsx", "utf8");
    const header = ui.slice(ui.indexOf("<TableHeader>"), ui.indexOf("</TableHeader>"));
    assert.deepEqual([...header.matchAll(/<TableHead[^>]*>(?:\{[LT]\.(\w+)\}|(\w+))<\/TableHead>/g)].map((m) => m[1] ?? m[2]), ["market", "partyOptions", "status", "planDate", "days"], "exactly five columns, in order");
    assert.ok(ui.includes("PartyOptionsDrawer") && ui.includes("setDrawerPlanId(p.id)") && ui.includes("fixed inset-0") && ui.includes("aria-label={T.closeDrawer}") && DEFAULT_LABELS["party_planning.monthly.aria.close_drawer"] === "Close drawer", "Party Options still opens the right-side drawer");
    assert.ok(!/OptionDialog|onOpenOption|\/options\/\$\{|\/transition/.test(ui), "no per-option status actions remain in the UI");
    assert.ok(ui.includes("/api/party-monthly-plans/${plan.id}/status") && ui.includes("StatusDialog") && ui.includes("StatusTimelineDialog") && ui.includes("T.confirmStatus") && DEFAULT_LABELS["party_planning.monthly.action.confirm_status"] === "Confirm {status}" && ui.includes("T.actuallyReceived") && DEFAULT_LABELS["party_planning.monthly.doc.actually_received"] === "Actually Received" && ui.includes("T.bySo") && DEFAULT_LABELS["party_planning.monthly.doc.submitted_by_so"] === "Submitted by the Sales Officer", "status dialog: confirm step, SO info shown apart from what was actually received, timeline");
    assert.ok(!ui.includes("text-green-600") && !ui.includes("/conversion-date") && !ui.includes("adminConfirmed"), "the green-tick / manual Admin confirmation is gone");
    assert.ok(ui.includes("rounded-full bg-muted") && ui.includes("DateHistoryDialog"), "the grey SO counter and date history remain");
    const server = readFileSync("src/features/party-planning/monthly.server.ts", "utf8");
    assert.ok(server.includes("seasonalPlan: { select: { createdAt: true } }") && !/conversionDays\([^)]*r\.createdAt/.test(server), "Days start from the Seasonal Plan row's created date, not the Monthly row's");
    const routes = readFileSync("src/features/accounts/route-permissions.ts", "utf8");
    assert.ok(routes.includes('p.endsWith("/status")') && !routes.includes("/conversion-date"), "route rule for the row status endpoint (service enforces owner / Admin)");
  }

  /* ---- wiring / non-regression ---- */
  {
    const server = readFileSync("src/features/party-planning/monthly.server.ts", "utf8");
    const info = readFileSync("src/features/party-planning/season-info.server.ts", "utf8");
    assert.ok(info.includes("SEASON_MONTH_ORDER") && !/orderBy: \{ order: "asc" \}/.test(info + server), "months use the calendar ordering helper, never SeasonMonth.order");
    assert.ok(!/prisma\.(market|season|seasonMonth)\.(create|update|delete|upsert)/.test(server + info), "Monthly Planning keeps no market / season / month list of its own");
    assert.ok(!/dealer\.(create|update)/.test(server), "no Dealer is created or edited");
    const migration = readFileSync("prisma/migrations/20261007030000_party_plan_sheets/migration.sql", "utf8");
    assert.ok(/INSERT INTO "PartyMonthlySheet"[\s\S]*UPDATE "PartyMonthlyPlan" SET "sheetId"[\s\S]*SET NOT NULL/.test(migration), "existing rows are linked to a plan before the column becomes required");
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    assert.ok(/model PartyMonthlySheet \{[\s\S]*?@@unique\(\[ownerId, seasonMonthId\]\)/.test(schema) && /model PartyMonthlyPlan \{[\s\S]*?@@unique\(\[seasonalPlanId, seasonMonthId\]\)/.test(schema));
  }
  void SO3;
  console.log("monthly.test.ts — all assertions passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
