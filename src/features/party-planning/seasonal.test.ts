/**
 * Seasonal Planning service contracts (real service, in-memory database): a Seasonal Plan is created for a CHOSEN open season and opened by id;
 * plans of different seasons coexist; scope + draft privacy; spoof-proofing; the SO → RM → Admin and RM → Admin approval routes; and
 * "approval makes a row Pending — never Appointed, never dated". Nothing depends on a "current season".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const USERS = [
  { id: "admin", name: "Admin", role: Role.SUPER_ADMIN, groupId: null },
  { id: "rm1", name: "RM One", role: Role.REGIONAL_MANAGER, groupId: "g1" },
  { id: "so1", name: "Officer One", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "so2", name: "Officer Two", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "rm2", name: "RM Two", role: Role.REGIONAL_MANAGER, groupId: "g2" },
  { id: "so3", name: "Officer Three", role: Role.SALES_OFFICER, groupId: "g2" },
  { id: "so4", name: "Officer Four", role: Role.SALES_OFFICER, groupId: "g9" }, // a group with no RM
];

function makeDb() {
  const t = {
    sheets: [] as Row[], plans: [] as Row[], audit: [] as Row[],
    // Several seasons at once (the old "one current season" rule is gone): two OPEN, one CLOSED. Kharif's period is the Seasons page's text.
    seasons: [
      { id: "s-kharif", name: "Kharif", year: 2026, status: "OPEN", period: "Apr 2026 → Nov 2026", months: [{ id: "sm-apr", name: "April", label: "April 2026", key: "2026-04" }] },
      { id: "s-rabi", name: "Rabi", year: 2026, status: "OPEN", period: "Nov 2026 → Mar 2027", months: [{ id: "sm-nov", name: "November", label: "November 2026", key: "2026-11" }] },
      { id: "s-old", name: "Season", year: 2025, status: "CLOSED", period: "Jun 2025 → Nov 2025", months: [] },
    ] as Row[],
    markets: [
      { id: "m-exist", name: "Pipariya", source: "EXISTING", potential: "B" },
      { id: "m-new", name: "Bareli", source: "REQUESTED", potential: "A" },
      { id: "m-undecided", name: "Rewa", source: "EXISTING", potential: null },
    ] as Row[],
    dealerWrites: 0,
  };
  let seq = 0, clock = 0;
  const tick = () => new Date(Date.UTC(2026, 9, 7, 0, 0, ++clock));
  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (key === "AND") return (cond as Row[]).every((c) => matches(row, c));
      if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
      if (key === "market") return matches(t.markets.find((m) => m.id === row.marketId)!, cond as Row);
      if (key === "ownerId_seasonId") return row.ownerId === cond.ownerId && row.seasonId === cond.seasonId;
      if (cond && typeof cond === "object") {
        const c = cond as Row;
        if ("in" in c) return c.in.includes(row[key]);
        if ("not" in c) return row[key] !== c.not;
        if ("contains" in c) return String(row[key] ?? "").toLowerCase().includes(String(c.contains).toLowerCase());
      }
      return (row[key] ?? null) === (cond ?? null);
    });
  };
  const seasonOf = (id: string) => t.seasons.find((s) => s.id === id)!;
  const sheetView = (r: Row) => ({ ...r, season: { name: seasonOf(r.seasonId).name, year: seasonOf(r.seasonId).year, status: seasonOf(r.seasonId).status }, owner: { name: USERS.find((u) => u.id === r.ownerId)?.name }, items: t.plans.filter((p) => p.sheetId === r.id).map((p) => ({ approvalStatus: p.approvalStatus, ownerId: p.ownerId, updatedAt: p.updatedAt })) });
  const planView = (r: Row): Row => ({ ...r, market: t.markets.find((m) => m.id === r.marketId), owner: { name: USERS.find((u) => u.id === r.ownerId)?.name }, season: { name: seasonOf(r.seasonId).name, year: seasonOf(r.seasonId).year } });
  const defaults = { approvalStatus: "DRAFT", rmDecidedById: null, rmDecidedAt: null, adminDecidedById: null, adminDecidedAt: null, rejectionStage: null, rejectionReason: null, approvedMarketSource: null, approvedMarketPotential: null, appointmentStatus: null, appointedAt: null };
  const prisma = {
    market: { findUnique: async ({ where }: Row) => { const m = t.markets.find((x) => matches(x, where)); return m ? { ...m } : null; } },
    user: { findMany: async ({ where }: Row) => USERS.filter((u) => where.id.in.includes(u.id)) },
    seasonalPlanSheet: {
      create: async ({ data }: Row) => { const row = { id: `sh${++seq}`, ...data, createdAt: tick(), updatedAt: tick() }; t.sheets.push(row); return sheetView(row); },
      findUnique: async ({ where }: Row) => { const r = t.sheets.find((x) => matches(x, where)); return r ? sheetView(r) : null; },
      findMany: async ({ where }: Row) => t.sheets.filter((r) => matches(r, where)).map(sheetView),
    },
    seasonalPlan: {
      create: async ({ data }: Row) => { const row = { id: `p${++seq}`, ...defaults, ...data, createdAt: tick(), updatedAt: tick() }; t.plans.push(row); return planView(row); },
      findUnique: async ({ where }: Row) => { const r = t.plans.find((x) => matches(x, where)); return r ? planView(r) : null; },
      findMany: async ({ where }: Row) => t.plans.filter((r) => matches(r, where)).map(planView).sort((a, b) => b.createdAt - a.createdAt),
      update: async ({ where, data }: Row) => { const r = t.plans.find((x) => matches(x, where))!; Object.assign(r, data, { updatedAt: tick() }); return planView(r); },
      updateMany: async ({ where, data }: Row) => { const rows = t.plans.filter((x) => matches(x, where)); rows.forEach((r) => Object.assign(r, data, { updatedAt: tick() })); return { count: rows.length }; },
      delete: async ({ where }: Row) => { t.plans = t.plans.filter((x) => !matches(x, where)); return {}; },
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      const snapshot = structuredClone([t.sheets, t.plans]);
      try { return await fn(prisma); } catch (e) { [t.sheets, t.plans] = snapshot as Row[][]; throw e; }
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
  const seasonInfo = (id: string) => db.t.seasons.find((s) => s.id === id);
  const load = testLoader({
    "@/lib/prisma": { prisma: db.prisma },
    "@/lib/http": { ApiError: TestApiError },
    "@/lib/audit": { writeAudit: async (p: Row) => { db.t.audit.push({ ...p }); } },
    "@/lib/scope": {
      getOfficerScope,
      getCurrentManagerId: async (officerId: string) => { const me = USERS.find((u) => u.id === officerId); return USERS.find((u) => u.role === Role.REGIONAL_MANAGER && u.groupId === me?.groupId && u.id !== officerId)?.id ?? null; },
    },
    // The Seasons module's rules, as the real helpers behave: ANY open season, by id — there is no "current season" anywhere.
    "./season-info.server": {
      getSeasonInfo: async (id: string) => { const s = seasonInfo(id); return s ? { ...s } : null; },
      isSeasonOpen: async (id: string) => seasonInfo(id)?.status === "OPEN",
      listOpenSeasonInfos: async () => db.t.seasons.filter((s) => s.status === "OPEN").map((s) => ({ ...s })),
    },
  });
  return { service: load("src/features/party-planning/seasonal.server.ts") as typeof import("./seasonal.server"), ...db };
}

const ctxOf = (userId: string): AuthContext => { const u = USERS.find((x) => x.id === userId)!; return { userId, role: u.role, username: userId, groupId: u.groupId, designation: null } as unknown as AuthContext; };
const SO1 = ctxOf("so1"), SO2 = ctxOf("so2"), SO3 = ctxOf("so3"), SO4 = ctxOf("so4"), RM1 = ctxOf("rm1"), RM2 = ctxOf("rm2"), ADMIN = ctxOf("admin");
async function status(fn: () => Promise<unknown>): Promise<number> { try { await fn(); return 0; } catch (e) { return (e as { status?: number }).status ?? -1; } }
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
type Svc = ReturnType<typeof loadService>["service"];
const sheetFor = (service: Svc, ctx: AuthContext, seasonId = "s-kharif") => service.createSeasonalSheet(ctx, { seasonId });
const addRow = (service: Svc, ctx: AuthContext, sheetId: string, marketId = "m-exist", partyName = "ABC Traders") => service.createSeasonalPlan(ctx, { sheetId, marketId, partyName });

async function main() {
  /* ---- create: the user CHOOSES an open season; nothing is picked automatically ---- */
  {
    const { service, t } = loadService();
    const opts = plain(await service.getSeasonalOptions(SO1));
    assert.deepEqual(opts.seasons.map((s) => [s.name, s.hasPlan]), [["Kharif", false], ["Rabi", false]], "every OPEN season is offered (and only OPEN ones) — none is pre-selected");
    assert.equal(opts.seasons[0]!.period, "Apr 2026 → Nov 2026");
    const kharif = plain(await sheetFor(service, SO1, "s-kharif"));
    assert.deepEqual([kharif.seasonId, kharif.seasonName, kharif.status, kharif.itemCount, kharif.own], ["s-kharif", "Kharif 2026", "Draft", 0, true], "the plan stores the CHOSEN season; a new plan is an empty Draft");
    const rabi = plain(await sheetFor(service, SO1, "s-rabi"));
    assert.equal(rabi.seasonId, "s-rabi", "a second season gets its own plan");
    assert.deepEqual(plain(await service.getSeasonalOptions(SO1)).seasons.map((s) => s.hasPlan), [true, true], "the dialog flags seasons that already have a plan");
    assert.equal(await status(() => sheetFor(service, SO1, "s-kharif")), 409, "one Seasonal Plan per season");
    assert.equal(await status(() => sheetFor(service, SO2, "s-kharif")), 0, "another officer may have their own for the same season");
    assert.equal(await status(() => sheetFor(service, SO1, "s-old")), 409, "a CLOSED season cannot be chosen");
    assert.equal(await status(() => sheetFor(service, SO1, "s-nope")), 422, "an unknown season is refused");
    assert.equal(await status(() => service.createSeasonalSheet(SO1, {})), 422);
    const adminSheet = plain(await sheetFor(service, ADMIN));
    assert.deepEqual([adminSheet.ownerId, adminSheet.ownerName, adminSheet.own, adminSheet.status], ["admin", "Admin", true, "Draft"], "Admin creates a plan in their own right (owner = the Admin user, no SO borrowed)");
    assert.equal(await status(() => sheetFor(service, ADMIN)), 409, "…one per season, like everyone");
    assert.equal(await status(() => service.createSeasonalSheet({ ...ADMIN, role: Role.CUSTOM_ADMIN, permissions: {} } as unknown as AuthContext, { seasonId: "s-rabi" })), 403, "a custom admin without Party Planning manage cannot create");
    const spoof = plain(await service.createSeasonalSheet(RM1, { seasonId: "s-kharif", ownerId: "so3", status: "Approved", itemCount: 9 }));
    assert.deepEqual([spoof.ownerId, spoof.status, spoof.itemCount], ["rm1", "Draft", 0], "owner / status cannot be spoofed");
    assert.equal(t.sheets.length, 5);
    const src = readFileSync("src/features/party-planning/seasonal.server.ts", "utf8");
    assert.ok(!/getCurrentSeason|getCurrentOpenSeason|currentOpenSeason/.test(src), "Seasonal Planning no longer resolves any 'current season'");
  }

  /* ---- Admin: full visibility + own plans ---- */
  {
    const { service } = loadService();
    const so = await sheetFor(service, SO1), rm = await sheetFor(service, RM1), adm = await sheetFor(service, ADMIN), other = await sheetFor(service, SO3);
    const row = await addRow(service, SO1, so.id, "m-exist", "Hidden Draft Party");
    assert.deepEqual(ids(await service.listSeasonalSheets(ADMIN)), ids([so, rm, adm, other]), "Admin lists SO-, RM- and Admin-created plans");
    assert.equal(plain((await service.listSeasonalSheets(ADMIN)).find((s) => s.id === adm.id)!).own, true);
    const opened = plain(await service.getSeasonalSheet(ADMIN, so.id));
    assert.deepEqual(opened.plans.map((p) => p.partyName), ["Hidden Draft Party"], "Admin sees the officer's draft rows on the plan");
    assert.equal(opened.plans[0]!.editable, false, "…read-only: Admin cannot edit another officer's row");
    assert.equal(opened.plans[0]!.canReview, false, "…and a Draft row is not reviewable");
    assert.equal(await status(() => service.getSeasonalSheet(ADMIN, adm.id)), 0, "Admin opens their own plan");
    assert.equal(await status(() => service.getSeasonalSheet(ADMIN, "nope")), 404);
    assert.equal(await status(() => service.updateSeasonalPlan(ADMIN, row.id, { partyName: "x" })), 403, "Admin visibility does not grant editing");
    assert.equal(await status(() => service.submitSeasonalPlan(ADMIN, row.id)), 403);
    assert.equal(plain(await service.getSeasonalOptions(ADMIN)).seasons.find((s) => s.id === "s-kharif")!.hasPlan, true, "the create dialog flags Admin's own plan");
    // SO / RM scope is unchanged
    assert.deepEqual(ids(await service.listSeasonalSheets(SO1)), [so.id], "an SO still sees only their own");
    assert.deepEqual(ids(await service.listSeasonalSheets(RM1)), [rm.id], "an RM still sees only their own until a team row is submitted");
    await service.submitSeasonalPlan(SO1, row.id);
    assert.deepEqual(ids(await service.listSeasonalSheets(RM1)), ids([so, rm]), "…then their team's");
  }

  /* ---- list across seasons + open by id ---- */
  {
    const { service } = loadService();
    const k1 = await sheetFor(service, SO1, "s-kharif"), r1 = await sheetFor(service, SO1, "s-rabi"), k2 = await sheetFor(service, SO2, "s-kharif"), k3 = await sheetFor(service, SO3, "s-kharif");
    assert.deepEqual(ids(await service.listSeasonalSheets(SO1)), ids([k1, r1]), "plans of DIFFERENT seasons appear together in the list");
    assert.deepEqual(ids(await service.listSeasonalSheets(SO1, { seasonId: "s-rabi" })), [r1.id], "season filter");
    assert.deepEqual((await service.listSeasonalSheets(SO1)).map((s) => s.seasonName).sort(), ["Kharif 2026", "Rabi 2026"]);
    // Others' plans are visible to reviewers only once something has left Draft.
    assert.equal((await service.listSeasonalSheets(RM1)).length, 0, "an RM does not see empty / draft plans of their team");
    const row = await addRow(service, SO2, k2.id);
    assert.equal((await service.listSeasonalSheets(RM1)).length, 0, "…nor draft rows");
    await service.submitSeasonalPlan(SO2, row.id);
    assert.deepEqual(ids(await service.listSeasonalSheets(RM1)), [k2.id], "after submission the RM sees it (their team only)");
    assert.deepEqual(plain((await service.listSeasonalSheets(RM1))[0]).status, "Pending Approval");
    assert.equal((await service.listSeasonalSheets(RM1, { needsReview: true })).length, 1, "'Needs my review' keeps the review queue reachable without separate tabs");
    assert.equal((await service.listSeasonalSheets(RM2)).length, 0, "another group's RM sees nothing of it");
    assert.deepEqual(ids(await service.listSeasonalSheets(ADMIN)), ids([k1, r1, k2, k3]), "Admin sees EVERY officer's plan — drafts and empty plans included");
    assert.equal(await status(() => service.getSeasonalSheet(ADMIN, k1.id)), 0, "Admin can open another user's (draft) plan");
    assert.equal(await status(() => service.getSeasonalSheet(RM1, k1.id)), 404, "…while an RM still cannot see an empty / draft plan of their team");
    assert.equal(await status(() => service.getSeasonalSheet(SO3, k1.id)), 404, "…and an SO cannot open another SO's plan");
    assert.equal((await service.listSeasonalSheets(ADMIN, { needsReview: true })).length, 0, "…but nothing is waiting on ADMIN until the RM approves");
    assert.equal((await service.listSeasonalSheets(SO2)).length, 1);
    assert.equal(await status(() => service.listSeasonalSheets({ ...SO1, role: undefined } as unknown as AuthContext)), 403);

    // OPEN loads the exact plan — from its id, in its own season (Rabi is not "current" anywhere).
    const rabi = plain(await service.getSeasonalSheet(SO1, r1.id));
    assert.deepEqual([rabi.sheet.id, rabi.season.name, rabi.season.period, rabi.plans.length], [r1.id, "Rabi", "Nov 2026 → Mar 2027", 0], "the detail shows the plan's own season and period");
    const kharif = plain(await service.getSeasonalSheet(SO1, k1.id));
    assert.deepEqual([kharif.season.name, kharif.season.period], ["Kharif", "Apr 2026 → Nov 2026"]);
    assert.equal(await status(() => service.getSeasonalSheet(SO1, k2.id)), 404, "another officer's plan looks missing");
    assert.equal(await status(() => service.getSeasonalSheet(SO3, k2.id)), 404, "…and so does one outside an RM / SO scope");
    assert.equal(await status(() => service.getSeasonalSheet(RM2, k2.id)), 404);
    assert.equal(await status(() => service.getSeasonalSheet(SO1, "nope")), 404);
    assert.equal(await status(() => service.getSeasonalSheet(RM1, k2.id)), 0, "the team's RM may open it");
    assert.equal(await status(() => service.getSeasonalSheet(RM1, k1.id)), 404, "…but a draft-only plan of the team stays private");
    void k3;
    // Reviewers see only non-draft rows, and which ones they can act on.
    await addRow(service, SO2, k2.id, "m-new", "Second (draft)");
    const rm = plain(await service.getSeasonalSheet(RM1, k2.id));
    assert.deepEqual(rm.plans.map((p) => [p.marketName, p.canReview, p.editable]), [["Pipariya", true, false]], "the RM sees the submitted row (not the draft) and may review it");
    assert.equal(plain(await service.getSeasonalSheet(SO2, k2.id)).plans.length, 2, "the owner sees every row");
    assert.equal(plain(await service.getSeasonalSheet(SO2, k2.id, "second")).plans.length, 1, "search");
  }

  /* ---- rows: the season comes from the plan, markets from the Phase-1 master, nothing from the browser ---- */
  {
    const { service, t } = loadService();
    const kharif = await sheetFor(service, SO1, "s-kharif"), rabi = await sheetFor(service, SO1, "s-rabi");
    const a = plain(await addRow(service, SO1, kharif.id, "m-exist", "  ABC   Traders "));
    assert.deepEqual([a.sheetId, a.seasonId, a.ownerId, a.marketName, a.type, a.marketPotential, a.status, a.appointmentDate, a.partyName, a.approvalStatus], [kharif.id, "s-kharif", "so1", "Pipariya", "Existing", "B", "—", null, "ABC Traders", "DRAFT"]);
    const b = plain(await addRow(service, SO1, rabi.id, "m-new", "Rabi party"));
    assert.deepEqual([b.seasonId, b.type, b.marketPotential], ["s-rabi", "New", "A"], "a row belongs to ITS plan's season (Rabi), whatever other seasons are open");
    assert.equal(plain(await addRow(service, SO1, kharif.id, "m-undecided", "X")).marketPotential, null);
    const spoof = plain(await service.createSeasonalPlan(SO1, { sheetId: kharif.id, marketId: "m-exist", partyName: "Spoof", type: "New", marketPotential: "A", ownerId: "so2", seasonId: "s-rabi", approvalStatus: "APPROVED", status: "Appointed", appointmentStatus: "APPOINTED", appointedAt: "2026-01-01", marketName: "Fake" }));
    assert.deepEqual([spoof.ownerId, spoof.seasonId, spoof.type, spoof.marketPotential, spoof.status, spoof.appointmentDate, spoof.approvalStatus, spoof.marketName], ["so1", "s-kharif", "Existing", "B", "—", null, "DRAFT", "Pipariya"], "owner / season / type / potential / status cannot be spoofed");
    assert.deepEqual([t.plans.find((r) => r.id === spoof.id)!.appointmentStatus, t.plans.find((r) => r.id === spoof.id)!.appointedAt], [null, null]);
    const edited = plain(await service.updateSeasonalPlan(SO1, a.id, { partyName: "Renamed", ownerId: "so2", approvalStatus: "APPROVED", seasonId: "s-rabi", type: "New", marketPotential: "A" }));
    assert.deepEqual([edited.partyName, edited.ownerId, edited.approvalStatus, edited.seasonId, edited.type], ["Renamed", "so1", "DRAFT", "s-kharif", "Existing"], "an edit cannot change owner, status, season, type or potential");
    // validation + ownership
    assert.equal(await status(() => addRow(service, SO1, kharif.id, "nope", "P")), 422, "an unknown Market is rejected");
    assert.equal(await status(() => addRow(service, SO1, kharif.id, "pending-request-id", "P")), 422, "a Market that is only a pending request is not a Market");
    assert.equal(await status(() => service.createSeasonalPlan(SO1, { marketId: "m-exist", partyName: "P" })), 422, "a row needs its Seasonal Plan (no implicit 'current season')");
    for (const bad of ["", "   ", undefined, "x".repeat(201)]) assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: kharif.id, marketId: "m-exist", partyName: bad })), 422);
    assert.equal(await status(() => addRow(service, SO2, kharif.id)), 404, "another officer's plan cannot receive rows");
    assert.equal(await status(() => addRow(service, ADMIN, kharif.id)), 403);
    assert.equal(await status(() => service.updateSeasonalPlan(SO2, a.id, { partyName: "hijack" })), 404);
    assert.equal(await status(() => service.deleteSeasonalPlan(SO2, a.id)), 404);
    assert.equal(await status(() => service.submitSeasonalPlan(SO2, a.id)), 404);
    assert.equal(await status(() => service.updateSeasonalPlan(RM1, a.id, { partyName: "hijack" })), 404, "an RM cannot edit a team member's row");
    assert.equal(t.dealerWrites, 0, "no Dealer is created or edited");
    // A season that closes makes ITS plan read-only (other seasons are unaffected).
    t.seasons.find((s) => s.id === "s-rabi")!.status = "CLOSED";
    assert.equal(await status(() => addRow(service, SO1, rabi.id)), 409, "no new rows in a closed season");
    assert.equal(await status(() => service.updateSeasonalPlan(SO1, b.id, { partyName: "x" })), 409);
    assert.equal(await status(() => service.submitSeasonalPlan(SO1, b.id)), 409);
    assert.equal(await status(() => service.updateSeasonalPlan(SO1, a.id, { partyName: "still editable" })), 0, "Kharif is untouched");
    assert.equal(plain(await service.getSeasonalSheet(SO1, rabi.id)).plans.length, 1, "a closed season's plan stays readable");
    await service.deleteSeasonalPlan(SO1, spoof.id);
    assert.equal(t.plans.some((r) => r.id === spoof.id), false);
  }

  /* ---- approval: SO → RM → Admin (row-level, unchanged) ---- */
  {
    const { service, t } = loadService();
    const sheet = await sheetFor(service, SO1);
    const plan = await addRow(service, SO1, sheet.id);
    assert.equal(await status(() => service.actOnSeasonalPlan(RM1, plan.id, { action: "approve" })), 409, "a draft cannot be reviewed");
    assert.equal((await service.submitSeasonalPlan(SO1, plan.id)).approvalStatus, "PENDING_RM", "an SO's row goes to their RM first");
    assert.equal(await status(() => service.submitSeasonalPlan(SO1, plan.id)), 409);
    assert.equal(await status(() => service.updateSeasonalPlan(SO1, plan.id, { partyName: "late edit" })), 409);
    assert.equal(await status(() => service.deleteSeasonalPlan(SO1, plan.id)), 409);
    assert.equal(await status(() => service.actOnSeasonalPlan(ADMIN, plan.id, { action: "approve" })), 409, "Admin cannot skip the RM step");
    assert.equal(await status(() => service.actOnSeasonalPlan(RM2, plan.id, { action: "approve" })), 403, "another group's RM is refused");
    assert.equal(await status(() => service.actOnSeasonalPlan(SO2, plan.id, { action: "approve" })), 403);
    assert.equal(await status(() => service.actOnSeasonalPlan(RM1, plan.id, { action: "reject" })), 422, "RM rejection needs a reason");
    const rmOk = await service.actOnSeasonalPlan(RM1, plan.id, { action: "approve" });
    assert.deepEqual([rmOk.approvalStatus, rmOk.status, rmOk.rmDecidedByName, rmOk.appointmentDate, rmOk.canReview], ["PENDING_ADMIN", "—", "RM One", null, false], "RM approval is NOT final");
    assert.equal(plain((await service.listSeasonalSheets(ADMIN, { needsReview: true }))[0]).needsMyReview, 1, "now it waits on Admin");
    assert.equal(await status(() => service.actOnSeasonalPlan(ADMIN, plan.id, { action: "reject", reason: " " })), 422);
    t.markets.find((m) => m.id === "m-exist")!.potential = "C";
    const done = await service.actOnSeasonalPlan(ADMIN, plan.id, { action: "approve" });
    assert.deepEqual([done.approvalStatus, done.status, done.appointmentDate, done.adminDecidedByName], ["APPROVED", "Pending", null, "Admin"], "final approval → Pending, NOT Appointed, no date");
    assert.deepEqual([t.plans[0]!.appointmentStatus, t.plans[0]!.appointedAt, t.plans[0]!.approvedMarketPotential], ["PENDING", null, "C"]);
    t.markets.find((m) => m.id === "m-exist")!.potential = "A";
    assert.equal(plain(await service.getSeasonalSheet(ADMIN, sheet.id)).plans[0]!.marketPotential, "C", "an approved row keeps the potential Admin approved");
    assert.equal(plain((await service.listSeasonalSheets(SO1))[0]).status, "Approved", "the plan's list status follows its rows");
    assert.equal(await status(() => service.updateSeasonalPlan(SO1, plan.id, { partyName: "x" })), 409, "an approved row is read-only");
    assert.ok(t.audit.filter((a) => a.entity === "seasonalPlan" || a.entity === "seasonalPlanSheet").length >= 5, "create, row, submit, RM approval and final approval are audited");
  }
  {
    const { service } = loadService();
    const sheet = await sheetFor(service, RM1);
    const own = await addRow(service, RM1, sheet.id, "m-new", "RM's party");
    assert.equal((await service.submitSeasonalPlan(RM1, own.id)).approvalStatus, "PENDING_ADMIN", "an RM's row skips the RM step");
    assert.equal(await status(() => service.actOnSeasonalPlan(RM1, own.id, { action: "approve" })), 403, "an RM never approves their own row");
    assert.equal(await status(() => service.actOnSeasonalPlan(RM2, own.id, { action: "approve" })), 403);
    assert.deepEqual([(await service.actOnSeasonalPlan(ADMIN, own.id, { action: "approve" })).status], ["Pending"]);
    const lonely = await addRow(service, SO4, (await sheetFor(service, SO4)).id);
    assert.equal((await service.submitSeasonalPlan(SO4, lonely.id)).approvalStatus, "PENDING_ADMIN", "an SO with no RM goes straight to Admin");
    // Rejection round trip.
    const s1 = await sheetFor(service, SO1);
    const p = await addRow(service, SO1, s1.id, "m-exist", "Rejected one");
    await service.submitSeasonalPlan(SO1, p.id);
    const rej = await service.actOnSeasonalPlan(RM1, p.id, { action: "reject", reason: "Wrong market" });
    assert.deepEqual([rej.approvalStatus, rej.rejectionStage, rej.rejectionReason, rej.status, rej.editable], ["REJECTED", "RM", "Wrong market", "—", false]);
    assert.equal(plain((await service.listSeasonalSheets(SO1))[0]).status, "Needs Changes");
    assert.equal((await service.updateSeasonalPlan(SO1, p.id, { marketId: "m-new", partyName: "Fixed" })).marketName, "Bareli");
    const again = await service.submitSeasonalPlan(SO1, p.id);
    assert.deepEqual([again.approvalStatus, again.rejectionReason, again.rmDecidedByName], ["PENDING_RM", null, null], "resubmission clears the previous round");
    await service.actOnSeasonalPlan(RM1, p.id, { action: "approve" });
    assert.deepEqual([(await service.actOnSeasonalPlan(ADMIN, p.id, { action: "reject", reason: "Duplicate territory" })).rejectionStage], ["ADMIN"]);
  }

  /* ---- wiring / non-regression ---- */
  {
    const src = readFileSync("src/features/party-planning/seasonal.server.ts", "utf8");
    assert.ok(!/appointedAt:\s*(new Date|date|today)/.test(src) && !/appointmentStatus:\s*"APPOINTED"/.test(src), "no code path sets Appointed or an appointment date");
    assert.ok(!src.includes("Monthly"), "Monthly Planning is not implemented here");
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    assert.ok(/model SeasonalPlanSheet \{[\s\S]*?@@unique\(\[ownerId, seasonId\]\)/.test(schema) && /season\s+Season\s+@relation/.test(schema), "a plan references the existing Season (no second season master)");
    assert.ok(!/model SeasonalSeason|model PartySeason/.test(schema));
    const migration = readFileSync("prisma/migrations/20261007030000_party_plan_sheets/migration.sql", "utf8");
    assert.ok(/INSERT INTO "SeasonalPlanSheet"[\s\S]*UPDATE "SeasonalPlan" SET "sheetId"[\s\S]*SET NOT NULL/.test(migration), "existing rows are linked to a plan before the column becomes required");
    assert.ok(!/^\s*(DELETE FROM|DROP|TRUNCATE)\b/im.test(migration));
  }
  void SO3; void RM2;
  console.log("seasonal.test.ts — all assertions passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
