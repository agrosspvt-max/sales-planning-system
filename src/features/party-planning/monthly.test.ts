/**
 * Monthly Planning service contracts (real service + real season helpers, in-memory database): a Monthly Plan is created for a CHOSEN open season
 * and one of ITS months (calendar order), opened by id; plans of different seasons / months coexist; the Seasonal-Plan → market dependency;
 * two independent options; the transition rules per role; the append-only timeline; scope and spoof-proofing. Nothing uses a "current" season / month.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Role } from "@prisma/client";
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
  const itemsOf = (sheetId: string) => t.plans.filter((p) => p.sheetId === sheetId).map((p) => ({ updatedAt: p.updatedAt, options: t.options.filter((o) => o.monthlyPlanId === p.id).map((o) => ({ status: o.status, partyName: o.partyName, updatedAt: o.updatedAt })) }));
  const sheetView = (r: Row) => ({ ...r, season: { name: seasonOf(r.seasonId).name, year: seasonOf(r.seasonId).year, status: seasonOf(r.seasonId).status }, seasonMonth: { id: r.seasonMonthId, name: monthOf(r.seasonMonthId).name, calendarMonth: monthOf(r.seasonMonthId).calendarMonth, calendarYear: monthOf(r.seasonMonthId).calendarYear }, owner: { name: USERS.find((u) => u.id === r.ownerId)?.name }, items: itemsOf(r.id) });
  const planView = (p: Row) => {
    const sm = monthOf(p.seasonMonthId);
    return { ...p, season: { status: seasonOf(p.seasonId).status }, seasonMonth: { name: sm.name, calendarMonth: sm.calendarMonth, calendarYear: sm.calendarYear }, owner: { name: USERS.find((u) => u.id === p.ownerId)?.name },
      options: t.options.filter((o) => o.monthlyPlanId === p.id).sort((a, b) => a.optionNo - b.optionNo).map((o) => ({ ...o, events: t.events.filter((e) => e.optionId === o.id).sort((a, b) => a.createdAt - b.createdAt) })) };
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
      create: async ({ data }: Row) => { const row = { id: `ms${++seq}`, ...data, createdAt: tick(), updatedAt: tick() }; t.sheets.push(row); return sheetView(row); },
      findUnique: async ({ where }: Row) => { const r = t.sheets.find((x) => matches(x, where)); return r ? sheetView(r) : null; },
      findMany: async ({ where }: Row) => t.sheets.filter((r) => matches(r, where)).map(sheetView),
    },
    partyMonthlyPlan: {
      create: async ({ data }: Row) => { const row = { id: `mp${++seq}`, ...data, createdAt: tick(), updatedAt: tick() }; t.plans.push(row); return { ...row }; },
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
    partyMonthlyEvent: { create: async ({ data }: Row) => { if (t.failNextEvent) { t.failNextEvent = false; throw new Error("event write failed"); } const row = { id: `ev${++seq}`, ...data, createdAt: tick() }; t.events.push(row); return { ...row }; } },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      const snap = structuredClone([t.sheets, t.plans, t.options, t.events, t.audit, t.seasonalPlans]);
      try { return await fn(prisma); } catch (e) { [t.sheets, t.plans, t.options, t.events, t.audit, t.seasonalPlans] = snap as Row[][]; throw e; }
    },
  };
  return { prisma, t };
}

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
    "@/lib/scope": { getOfficerScope },
    // Only the Seasons module's OPEN-season LIST is faked; the season/month helpers in season-info.server.ts (calendar ordering, period text) run for real.
    "@/features/seasons/service.server": { listSeasons: async (_search: string, activeOnly: boolean) => db.t.seasons.filter((s) => !activeOnly || s.status === "OPEN").map((s) => ({ id: s.id })) },
  });
  return { service: load("src/features/party-planning/monthly.server.ts") as typeof import("./monthly.server"), ...db };
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
const opt = (p: { options: { optionNo: number }[] }, n: number) => p.options.find((o) => o.optionNo === n) as unknown as Awaited<ReturnType<typeof planFor>>["options"][number];
const move = (service: Svc, ctx: AuthContext, plan: { id: string }, optionNo: number, body: Row) => service.transitionOption(ctx, plan.id, optionNo, body);

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
    assert.deepEqual(plan.options.map((o) => [o.optionNo, o.status, o.partyName]), [[1, "PENDING", "Party A"], [2, "PENDING", "Party B"]], "both options start Pending");
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
    assert.deepEqual([spoof.ownerId, spoof.marketId, spoof.marketName, spoof.marketPotential, spoof.seasonId, spoof.seasonMonthId, spoof.options.map((o) => o.status)], ["so1", "m-new", "Bareli", "A", "s-kharif", "sm-june", ["PENDING", "PENDING"]], "owner / market / potential / season / month / status cannot be spoofed");
    // list status follows the options
    assert.equal(plain((await service.listMonthlySheets(SO1)).find((s) => s.id === june.id)!).status, "In Progress");
    t.seasons.find((s) => s.id === "s-kharif")!.status = "CLOSED";
    assert.equal(await status(() => service.createMonthlyPlan(SO1, { sheetId: april.id, seasonalPlanId: "sp-so1-new", planDate: "2026-04-11", option1Party: "late" })), 409, "no new rows in a closed season");
    assert.equal(plain(await service.getMonthlySheet(SO1, june.id)).plans.length, 2, "…but its plans stay readable");
  }

  /* ---- options: independent lifecycle + timeline ---- */
  {
    const { service, t } = loadService();
    const plan = await planFor(service);
    const events = (optionNo: number) => t.events.filter((e) => e.optionId === t.options.find((o) => o.monthlyPlanId === plan.id && o.optionNo === optionNo)!.id);
    for (const n of [1, 2]) { const [e] = events(n); assert.deepEqual([events(n).length, e!.eventType, e!.toStatus, e!.actorId, e!.actorName, e!.actorRole], [1, "PLAN_CREATED", "PENDING", "so1", "Officer One", "SALES_OFFICER"]); }
    assert.deepEqual(plain(events(1)[0]!.details), { optionNo: 1, marketName: "Pipariya", marketPotential: "B", month: "June 2026", planDate: "2026-06-15", partyName: "Party A" });

    assert.equal(await status(() => move(service, SO1, plan, 1, { to: "DOC_SENT" })), 422, "Doc Sent without details is refused");
    assert.equal(await status(() => move(service, SO1, plan, 1, { to: "DOC_SENT", sent: { other: true } })), 422, "'Other' needs a clarification");
    assert.equal(await status(() => move(service, ADMIN, plan, 1, { to: "DOC_SENT", sent: DOCS })), 403, "only the owner sends documents");
    assert.equal(await status(() => move(service, SO1, plan, 1, { to: "DOC_RECEIVED", received: DOCS })), 409, "Pending cannot jump to Doc Received");
    assert.equal(await status(() => move(service, SO1, plan, 1, { to: "APPOINTED", actualPartyName: "X" })), 409);
    const sent = plain(await move(service, SO1, plan, 1, { to: "DOC_SENT", sent: DOCS, actorId: "admin", sentAt: "1999-01-01" }));
    assert.deepEqual([opt(sent, 1).status, opt(sent, 2).status], ["DOC_SENT", "PENDING"], "Option 1 moves; Option 2 is untouched");
    assert.deepEqual([opt(sent, 1).sentInfo, opt(sent, 1).sentByName], [DOCS, "Officer One"]);
    assert.equal(opt(sent, 2).events.length, 1, "Option 2's timeline did not change");

    assert.equal(await status(() => move(service, SO1, plan, 1, { to: "DOC_RECEIVED", received: DOCS })), 403, "the SO cannot record 'received'");
    assert.equal(await status(() => move(service, RM1, plan, 1, { to: "DOC_RECEIVED", received: DOCS })), 403, "an RM cannot bypass the Admin step");
    assert.equal(await status(() => move(service, ADMIN, plan, 1, { to: "DOC_RECEIVED" })), 422);
    const received = plain(await move(service, ADMIN, plan, 1, { to: "DOC_RECEIVED", received: { documents: true, checks: false, other: false } }));
    assert.deepEqual([opt(received, 1).status, opt(received, 1).sentInfo, opt(received, 1).receivedInfo, opt(received, 1).receivedByName], ["DOC_RECEIVED", DOCS, { documents: true, checks: false, other: false, otherDetails: null }, "Admin"], "sent and received are stored separately");
    assert.deepEqual(plain(events(1).at(-1)!.details), { received: { documents: true, checks: false, other: false, otherDetails: null }, sentBySo: DOCS });

    assert.equal(await status(() => move(service, ADMIN, plan, 1, { to: "SD_DELAYED_BY_SO" })), 422, "a reason is required");
    assert.equal(await status(() => move(service, SO1, plan, 1, { to: "SD_DELAYED_BY_SO", reason: "late" })), 403);
    assert.equal(opt(plain(await move(service, ADMIN, plan, 1, { to: "SD_DELAYED_BY_SO", reason: "SD not received" })), 1).status, "SD_DELAYED_BY_SO");
    assert.equal(opt(plain(await move(service, ADMIN, plan, 1, { to: "SD_BOUNCE", reason: "Cheque returned" })), 1).status, "SD_BOUNCE");
    assert.equal(await status(() => move(service, ADMIN, plan, 1, { to: "SD_DELAYED_BY_SO", reason: "back?" })), 409, "no going back");

    assert.equal(await status(() => move(service, SO1, plan, 1, { to: "APPOINTED", actualPartyName: "ABC" })), 403, "the SO cannot appoint");
    assert.equal(await status(() => move(service, ADMIN, plan, 1, { to: "APPOINTED" })), 422);
    const today = currentBusinessDate();
    const appointed = plain(await move(service, ADMIN, plan, 1, { to: "APPOINTED", actualPartyName: " ABC  Traders (Pipariya) ", actualAppointedOn: "1999-01-01" }));
    assert.deepEqual([opt(appointed, 1).status, opt(appointed, 1).actualPartyName, opt(appointed, 1).actualAppointedOn, opt(appointed, 1).partyName], ["APPOINTED", "ABC Traders (Pipariya)", today, "Party A"], "the actual party differs from the tentative one; the date is the SERVER's business date");
    const sp = t.seasonalPlans.find((p) => p.id === "sp-so1")!;
    assert.deepEqual([sp.appointmentStatus, String(sp.appointedAt?.toISOString().slice(0, 10))], ["APPOINTED", today], "the Seasonal Plan records its actual appointment");
    assert.equal(opt(appointed, 2).status, "PENDING");
    assert.equal(await status(() => move(service, ADMIN, plan, 1, { to: "PART_REJECTED", reason: "x" })), 409, "Appointed is terminal");

    assert.equal(await status(() => move(service, ADMIN, plan, 2, { to: "PART_REJECTED" })), 422, "a rejection needs a reason");
    assert.equal(await status(() => move(service, SO1, plan, 2, { to: "PART_REJECTED", reason: "x" })), 403, "the SO cannot reject");
    await move(service, SO1, plan, 2, { to: "DOC_SENT", sent: { documents: true } });
    const rejected = plain(await move(service, ADMIN, plan, 2, { to: "PART_REJECTED", reason: "Documents incomplete" }));
    assert.deepEqual([opt(rejected, 2).status, opt(rejected, 2).rejectionReason, opt(rejected, 1).status], ["PART_REJECTED", "Documents incomplete", "APPOINTED"]);

    const tl1 = events(1), tl2 = events(2);
    assert.deepEqual(tl1.map((e) => e.toStatus), ["PENDING", "DOC_SENT", "DOC_RECEIVED", "SD_DELAYED_BY_SO", "SD_BOUNCE", "APPOINTED"]);
    assert.deepEqual(tl1.map((e) => e.fromStatus), [null, "PENDING", "DOC_SENT", "DOC_RECEIVED", "SD_DELAYED_BY_SO", "SD_BOUNCE"]);
    assert.deepEqual(tl1.map((e) => e.actorId), ["so1", "so1", "admin", "admin", "admin", "admin"]);
    assert.deepEqual(tl2.map((e) => e.toStatus), ["PENDING", "DOC_SENT", "PART_REJECTED"]);
    assert.deepEqual(plain(tl2.at(-1)!.details), { reason: "Documents incomplete" });
    assert.ok(tl1.every((e, i) => i === 0 || e.createdAt > tl1[i - 1]!.createdAt), "events are in time order");
    assert.equal(tl1.at(-1)!.toStatus, t.options.find((o) => o.id === tl1[0]!.optionId)!.status, "the timeline ends where the current status is");
    const source = readFileSync("src/features/party-planning/monthly.server.ts", "utf8");
    assert.ok(!/partyMonthlyEvent\.(update|updateMany|delete|deleteMany|upsert)/.test(source), "the service only ever INSERTs events");
    assert.ok(/CREATE TRIGGER "PartyMonthlyEvent_no_update"[\s\S]*CREATE TRIGGER "PartyMonthlyEvent_no_delete"/.test(readFileSync("prisma/migrations/20261007020000_party_monthly_planning/migration.sql", "utf8")), "the database refuses UPDATE / DELETE on events");
    assert.equal(plain((await service.listMonthlySheets(SO1))[0]).status, "Completed", "all options final → the plan is Completed");
  }

  /* ---- candidate party edits, atomicity, concurrency ---- */
  {
    const { service, t } = loadService();
    const plan = plain(await planFor(service));
    const renamed = plain(await service.updateMonthlyPlan(SO1, plan.id, { option2Party: "New B", planDate: "2026-06-20", ownerId: "so2", status: "APPOINTED" }));
    assert.deepEqual([opt(renamed, 2).partyName, renamed.planDate, renamed.ownerId, opt(renamed, 2).status], ["New B", "2026-06-20", "so1", "PENDING"]);
    assert.deepEqual(t.events.filter((e) => e.eventType === "PARTY_UPDATED").map((e) => plain(e.details)), [{ optionNo: 2, from: "Party B", to: "New B" }]);
    assert.equal(await status(() => service.updateMonthlyPlan(SO1, plan.id, { planDate: "2026-07-20" })), 422, "plan date stays inside the month");
    assert.equal(await status(() => service.updateMonthlyPlan(SO2, plan.id, { planDate: "2026-06-20" })), 404);
    await move(service, SO1, plan, 1, { to: "DOC_SENT", sent: DOCS });
    assert.equal(await status(() => service.updateMonthlyPlan(SO1, plan.id, { option1Party: "switch" })), 409, "the candidate cannot change after documents were sent");
    const fresh = await planFor(service, { seasonalPlanId: "sp-so1-new" });
    const snapshot = JSON.stringify([t.options.map((o) => [o.id, o.status, o.sentInfo]), t.events.length]);
    t.failNextEvent = true;
    assert.equal(await status(() => move(service, SO1, fresh, 2, { to: "DOC_SENT", sent: DOCS })), -1);
    assert.equal(JSON.stringify([t.options.map((o) => [o.id, o.status, o.sentInfo]), t.events.length]), snapshot, "option state and timeline stay consistent: both or neither");
    const racing = await planFor(service, { seasonalPlanId: "sp-so1-new", seasonMonthId: "sm-july", planDate: "2026-07-10" });
    const eventsBefore = t.events.length;
    t.onClaim = () => { t.options.find((x) => x.monthlyPlanId === racing.id && x.optionNo === 1)!.status = "DOC_SENT"; };
    assert.equal(await status(() => move(service, SO1, racing, 1, { to: "DOC_SENT", sent: DOCS })), 409, "a stale status is refused");
    assert.equal(t.events.length, eventsBefore, "and no event was appended");
    assert.equal(await status(() => move(service, ADMIN, plan, 3, { to: "DOC_RECEIVED", received: DOCS })), 422, "option must be 1 or 2");
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
    assert.equal(await status(() => move(service, SO2, so1Plan, 1, { to: "DOC_SENT", sent: DOCS })), 404, "an SO cannot touch another SO's plan by id");
    assert.equal(await status(() => move(service, RM1, so1Plan, 1, { to: "DOC_SENT", sent: DOCS })), 403, "an RM can see but not act on a team member's plan");
    assert.equal(await status(() => move(service, RM1, rmPlan, 1, { to: "DOC_SENT", sent: DOCS })), 0, "an RM plans their OWN markets like an SO");
    assert.equal(await status(() => move(service, RM1, rmPlan, 1, { to: "DOC_RECEIVED", received: DOCS })), 403, "…but cannot do the Admin step");
    assert.equal(await status(() => move(service, ADMIN, so1Plan, 1, { to: "DOC_SENT", sent: DOCS })), 403, "Admin does not do the owner step");
    assert.equal(await status(() => move(service, { ...SO1, role: undefined } as unknown as AuthContext, so1Plan, 1, { to: "DOC_SENT", sent: DOCS })), 403, "unknown role");
    // Filters: by season, and "needs my action" (Admin: waiting on Admin; owner: still Pending).
    assert.equal((await service.listMonthlySheets(ADMIN, { seasonId: "s-rabi" })).length, 0);
    assert.equal((await service.listMonthlySheets(ADMIN, { seasonId: "s-kharif" })).length, 3);
    assert.deepEqual(ids(await service.listMonthlySheets(ADMIN, { needsAction: true })), [(await service.listMonthlySheets(RM1)).find((s) => s.own)!.id], "only the plan with a Doc Sent option waits on Admin");
    assert.equal((await service.listMonthlySheets(SO1, { needsAction: true })).length, 1, "the owner's plan still has Pending options to send");
    void sheetIds;
    // Within one plan: allowed moves by role.
    const so1Detail = plain(await service.getMonthlySheet(SO1, (await service.listMonthlySheets(SO1))[0]!.id));
    assert.deepEqual(so1Detail.plans[0]!.options.map((o) => o.allowed), [["DOC_SENT"], ["DOC_SENT"]]);
    const adminDetail = plain(await service.getMonthlySheet(ADMIN, (await service.listMonthlySheets(SO1))[0]!.id));
    assert.deepEqual(adminDetail.plans[0]!.options.map((o) => o.allowed), [["PART_REJECTED"], ["PART_REJECTED"]], "Admin may reject a Pending option but not send documents");
  }

  /* ---- a closed season keeps history but is read-only ---- */
  {
    const { service, t } = loadService();
    const plan = await planFor(service);
    await move(service, SO1, plan, 1, { to: "DOC_SENT", sent: DOCS });
    t.seasons.find((s) => s.id === "s-kharif")!.status = "CLOSED";
    assert.equal(await status(() => move(service, ADMIN, plan, 1, { to: "DOC_RECEIVED", received: DOCS })), 409, "a plan of a closed season is read-only");
    assert.equal(await status(() => service.updateMonthlyPlan(SO1, plan.id, { planDate: "2026-06-18" })), 409);
    assert.equal(t.plans.length, 1);
    assert.equal(t.events.filter((e) => e.monthlyPlanId === plan.id).length, 3, "history is never deleted");
    assert.deepEqual(plain(await service.getMonthlySheet(SO1, plan.sheetId)).plans[0]!.options.map((o) => o.allowed), [[], []], "no actions are offered");
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
