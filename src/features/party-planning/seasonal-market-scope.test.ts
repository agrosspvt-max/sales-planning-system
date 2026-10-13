/**
 * Seasonal Planning → Add / Edit Market: a planner may only choose Markets of their OWN territory. Runs the REAL seasonal service and the REAL
 * eligibility rule (seasonal-markets.server) against an in-memory database:
 *   eligible = the Market of each of the planner's CURRENT dealers (as Territory Mapping → Existing Markets shows it, manual edits included)
 *            ∪ Markets the planner requested through Vacant Market that Admin finally approved (linked to a Market record).
 */
import assert from "node:assert/strict";
import { Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const USERS = [
  { id: "admin", name: "Admin", role: Role.SUPER_ADMIN, groupId: null },
  { id: "rm1", name: "RM One", role: Role.REGIONAL_MANAGER, groupId: "g1" },
  { id: "so1", name: "Suresh Verma", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "so2", name: "Officer Two", role: Role.SALES_OFFICER, groupId: "g1" }, // SAME group / RM as so1 — a team scope must not widen the choices
  { id: "so3", name: "Officer Three", role: Role.SALES_OFFICER, groupId: "g2" }, // nothing mapped, nothing approved
];
const mkt = (id: string, name: string, extra: Row = {}) => ({ id, name, nameKey: name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), potential: "B", source: "EXISTING", ...extra });

function makeDb() {
  const t = {
    sheets: [] as Row[], plans: [] as Row[], audit: [] as Row[],
    seasons: [{ id: "s-kharif", name: "Kharif", year: 2026, status: "OPEN", period: "Apr 2026 → Nov 2026", months: [] as Row[] }] as Row[],
    markets: [
      mkt("m-karuamor", "Karuamor"), mkt("m-boring", "Boring Road", { source: "REQUESTED", potential: "A" }), mkt("m-pip", "Pipariya"), mkt("m-old", "Old Underlying Name"),
      mkt("m-shared", "Shared Mandi"), mkt("m-bareli", "Bareli"), mkt("m-rewa", "Rewa"), mkt("m-pending", "Pending Market"), mkt("m-rejected", "Rejected Market"),
      mkt("m-global", "Global Only"), mkt("m-gone", "Reassigned Away"), mkt("m-inactive", "Inactive Dealer Market"), mkt("m-deleted", "Deleted Dealer Market"),
    ] as Row[],
    dealers: [
      { id: "d1", deletedAt: null, isActive: true }, { id: "d2", deletedAt: null, isActive: true }, { id: "d3", deletedAt: null, isActive: true }, { id: "d4", deletedAt: null, isActive: true },
      { id: "d5", deletedAt: null, isActive: true }, { id: "d6", deletedAt: null, isActive: true }, { id: "d7", deletedAt: null, isActive: true }, { id: "d8", deletedAt: null, isActive: true },
      { id: "d-off", deletedAt: null, isActive: false }, { id: "d-del", deletedAt: new Date(), isActive: true },
    ] as Row[],
    // so1: d1 (Karuamor), d2 (Karuamor again → de-duplicated), d3 (underlying "Old Underlying Name" but EDITED to "Pipariya"), d4 (EDITED to a name with no Market record),
    //      d5 (shared with so2), d7 (inactive), d8 (deleted).  so2: d5 (shared), d6 (Bareli).  d9 was so1's, reassigned to so2 (open assignment only for so2).
    assignments: [
      { dealerId: "d1", officerId: "so1", effectiveTo: null }, { dealerId: "d2", officerId: "so1", effectiveTo: null }, { dealerId: "d3", officerId: "so1", effectiveTo: null },
      { dealerId: "d4", officerId: "so1", effectiveTo: null }, { dealerId: "d5", officerId: "so1", effectiveTo: null }, { dealerId: "d-off", officerId: "so1", effectiveTo: null }, { dealerId: "d-del", officerId: "so1", effectiveTo: null },
      { dealerId: "d5", officerId: "so2", effectiveTo: null, effectiveFromLater: true }, { dealerId: "d6", officerId: "so2", effectiveTo: null },
      { dealerId: "d7", officerId: "so1", effectiveTo: new Date() }, { dealerId: "d7", officerId: "so2", effectiveTo: null },
    ] as Row[],
    mappings: [
      { dealerId: "d1", marketId: "m-karuamor", marketText: null }, { dealerId: "d2", marketId: "m-karuamor", marketText: null },
      { dealerId: "d3", marketId: "m-old", marketText: "Pipariya" }, { dealerId: "d4", marketId: "m-old", marketText: "Nowhere Mandi" },
      { dealerId: "d5", marketId: "m-shared", marketText: null }, { dealerId: "d6", marketId: "m-bareli", marketText: null },
      { dealerId: "d7", marketId: "m-gone", marketText: null }, { dealerId: "d-off", marketId: "m-inactive", marketText: null }, { dealerId: "d-del", marketId: "m-deleted", marketText: null },
    ].map((m, i) => ({ id: `mp${i + 1}`, ...m })) as Row[], // d4 → mp4 is the Karuamor-style fixture: an EDITED name with NO Market record
    requests: [
      { id: "r1", requesterId: "so1", status: "APPROVED", marketId: "m-boring" },          // approved, own, NO dealer on it
      { id: "r2", requesterId: "so1", status: "APPROVED", marketId: "m-karuamor" },        // approved + also mapped → de-duplicated
      { id: "r3", requesterId: "so1", status: "PENDING_ADMIN", marketId: null },
      { id: "r4", requesterId: "so1", status: "REJECTED", marketId: null },
      { id: "r5", requesterId: "so2", status: "APPROVED", marketId: "m-rewa" },            // ANOTHER officer's approved request
      { id: "r6", requesterId: "so1", status: "PENDING_RM", marketId: "m-pending" },       // never approved → excluded even if a Market row exists
      { id: "r7", requesterId: "so1", status: "REJECTED", marketId: "m-rejected" },
      { id: "r8", requesterId: "so2", status: "APPROVED", marketId: "m-shared" },          // shared market also approved for so2
    ] as Row[],
  };
  let seq = 0, clock = 0;
  const tick = () => new Date(Date.UTC(2026, 9, 7, 0, 0, ++clock));
  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (key === "AND") return (cond as Row[]).every((c) => matches(row, c));
      if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
      if (key === "ownerId_seasonId") return row.ownerId === cond.ownerId && row.seasonId === cond.seasonId;
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as Row;
        if ("in" in c) return c.in.includes(row[key]);
        if ("not" in c) return c.not === null ? row[key] !== null && row[key] !== undefined : row[key] !== c.not;
        if ("contains" in c) return String(row[key] ?? "").toLowerCase().includes(String(c.contains).toLowerCase());
      }
      return (row[key] ?? null) === (cond ?? null);
    });
  };
  let failNextMarketCreate = false; const racers: Row[] = []; // markets committed by the concurrent winner: they survive this transaction's rollback
  const queues = new Map<string, (() => void)[]>(); const held = new Set<string>(); 
  const acquire = async (id: string, mine: string[]) => { if (mine.includes(id)) return; while (held.has(id)) await new Promise<void>((r) => (queues.get(id) ?? queues.set(id, []).get(id)!).push(r)); held.add(id); mine.push(id); };
  const release = (id: string) => { held.delete(id); queues.get(id)?.shift()?.(); };
  const seasonOf = (id: string) => t.seasons.find((s) => s.id === id)!;
  const sheetView = (r: Row) => ({ ...r, season: { name: seasonOf(r.seasonId).name, year: seasonOf(r.seasonId).year, status: seasonOf(r.seasonId).status }, owner: { name: USERS.find((u) => u.id === r.ownerId)?.name }, items: t.plans.filter((p) => p.sheetId === r.id).map((p) => ({ approvalStatus: p.approvalStatus, ownerId: p.ownerId, updatedAt: p.updatedAt })) });
  const planView = (r: Row): Row => ({ ...r, market: t.markets.find((m) => m.id === r.marketId), owner: { name: USERS.find((u) => u.id === r.ownerId)?.name }, season: { name: seasonOf(r.seasonId).name, year: seasonOf(r.seasonId).year } });
  const defaults = { approvalStatus: "DRAFT", rmDecidedById: null, rmDecidedAt: null, adminDecidedById: null, adminDecidedAt: null, rejectionStage: null, rejectionReason: null, approvedMarketSource: null, approvedMarketPotential: null, appointmentStatus: null, appointedAt: null };
  const pickMarket = (id: string | null) => { const m = t.markets.find((x) => x.id === id); return m ? { id: m.id, name: m.name, potential: m.potential, source: m.source, nameKey: m.nameKey } : null; };
  const prisma = {
    market: {
      findUnique: async ({ where }: Row) => { const m = t.markets.find((x) => matches(x, where)); return m ? { ...m } : null; },
      create: async ({ data }: Row) => {
        if (failNextMarketCreate) { failNextMarketCreate = false; const racer = { id: `m-race${++seq}`, potential: null, source: "EXISTING", ...data, name: "Racer" }; t.markets.push(racer); racers.push(racer); throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" }); } // a concurrent save won the unique nameKey
        if (t.markets.some((m) => m.nameKey === data.nameKey)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row = { id: `m-new${++seq}`, potential: null, source: "EXISTING", ...data }; t.markets.push(row); return { ...row };
      },
      findMany: async ({ where }: Row) => t.markets.filter((m) => matches(m, where)).map((m) => pickMarket(m.id)),
    },
    dealer: { findMany: async ({ where }: Row) => t.dealers.filter((d) => matches(d, where)).map((d) => ({ id: d.id })) },
    dealerMarketMapping: {
      findMany: async ({ where }: Row) => t.mappings.filter((m) => matches(m, where)).map((m) => ({ id: m.id, marketId: m.marketId, marketText: m.marketText, market: pickMarket(m.marketId) })),
      findUnique: async ({ where }: Row) => { const m = t.mappings.find((x) => matches(x, where)); return m ? { id: m.id, dealerId: m.dealerId, marketText: m.marketText } : null; },
    },
    marketRequest: { findMany: async ({ where }: Row) => t.requests.filter((r) => matches(r, where)).map((r) => ({ market: pickMarket(r.marketId) })) },
    user: { findMany: async ({ where }: Row) => USERS.filter((u) => where.id.in.includes(u.id)) },
    seasonalPlanSheet: {
      create: async ({ data }: Row) => { const row = { id: `sh${++seq}`, ...data, createdAt: tick(), updatedAt: tick() }; t.sheets.push(row); return sheetView(row); },
      findUnique: async ({ where }: Row) => { const r = t.sheets.find((x) => matches(x, where)); return r ? sheetView(r) : null; },
      findMany: async ({ where }: Row) => t.sheets.filter((r) => matches(r, where)).map(sheetView),
      // The row lock of the real database: held until the surrounding transaction ends, so concurrent writers of ONE sheet run one after the other.
      updateMany: async ({ where }: Row, mine: string[] = []) => { const rows = t.sheets.filter((r) => matches(r, where)); for (const r of rows) await acquire(r.id, mine); return { count: rows.length }; },
    },
    seasonalPlan: {
      create: async ({ data }: Row) => { const row = { id: `p${++seq}`, ...defaults, ...data, createdAt: tick(), updatedAt: tick() }; t.plans.push(row); return planView(row); },
      findUnique: async ({ where }: Row) => { const r = t.plans.find((x) => matches(x, where)); return r ? planView(r) : null; },
      findFirst: async ({ where }: Row) => { const r = t.plans.find((x) => matches(x, where)); return r ? planView(r) : null; },
      findMany: async ({ where }: Row) => t.plans.filter((r) => matches(r, where)).map(planView).sort((a, b) => b.createdAt - a.createdAt),
      update: async ({ where, data }: Row) => { const r = t.plans.find((x) => matches(x, where))!; Object.assign(r, data, { updatedAt: tick() }); return planView(r); },
      updateMany: async ({ where, data }: Row) => { const rows = t.plans.filter((x) => matches(x, where)); rows.forEach((r) => Object.assign(r, data, { updatedAt: tick() })); return { count: rows.length }; },
      delete: async ({ where }: Row) => { t.plans = t.plans.filter((x) => !matches(x, where)); return {}; },
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      let snapshot = structuredClone([t.sheets, t.plans, t.markets, t.audit]); // re-taken once the sheet lock is held (a waiting transaction must not roll back to a stale start)
      const txLocks: string[] = [];
      const tx = { ...prisma, seasonalPlanSheet: { ...prisma.seasonalPlanSheet, updateMany: async (a: Row) => { const r = await prisma.seasonalPlanSheet.updateMany(a, txLocks); snapshot = structuredClone([t.sheets, t.plans, t.markets, t.audit]); return r; } } };
      try { return await fn(tx); } catch (e) { [t.sheets, t.plans, t.markets, t.audit] = snapshot as Row[][]; t.markets.push(...racers.filter((r) => !t.markets.some((m) => m.id === r.id))); throw e; } finally { for (const id of txLocks) release(id); }
    },
  };
  return { prisma, t, failMarketCreateOnce: () => { failNextMarketCreate = true; } };
}

function loadService() {
  const db = makeDb();
  // d5 is shared on purpose: the CURRENT owner of a dealer is its single most-recent open assignment (so2 here), the same rule as Territory Mapping.
  const currentOwner = (dealerId: string) => { const open = db.t.assignments.filter((a) => a.dealerId === dealerId && a.effectiveTo === null); return (open.find((a) => a.effectiveFromLater) ?? open.at(-1))?.officerId; };
  const getOfficerScope = async (ctx: AuthContext) => ctx.role === Role.SUPER_ADMIN ? { all: true, ids: [] as string[] } : ctx.role === Role.SALES_OFFICER ? { all: false, ids: [ctx.userId] } : { all: false, ids: [ctx.userId, ...USERS.filter((u) => u.role === Role.SALES_OFFICER && u.groupId === ctx.groupId).map((u) => u.id)] };
  const load = testLoader({
    "@/lib/prisma": { prisma: db.prisma },
    "@/lib/http": { ApiError: TestApiError },
    "@/lib/audit": { writeAudit: async (p: Row) => { db.t.audit.push({ ...p }); } },
    "@/lib/scope": {
      getOfficerScope,
      getCurrentManagerId: async (officerId: string) => { const me = USERS.find((u) => u.id === officerId); return USERS.find((u) => u.role === Role.REGIONAL_MANAGER && u.groupId === me?.groupId && u.id !== officerId)?.id ?? null; },
      getCurrentDealerIds: async (officerId: string) => [...new Set(db.t.assignments.filter((a) => a.officerId === officerId && a.effectiveTo === null).map((a) => a.dealerId))].filter((id) => currentOwner(id) === officerId),
    },
    "./season-info.server": {
      getSeasonInfo: async (id: string) => { const s = db.t.seasons.find((x) => x.id === id); return s ? { ...s } : null; },
      isSeasonOpen: async (id: string) => db.t.seasons.find((x) => x.id === id)?.status === "OPEN",
      listOpenSeasonInfos: async () => db.t.seasons.filter((s) => s.status === "OPEN").map((s) => ({ ...s })),
    },
  });
  return { service: load("src/features/party-planning/seasonal.server.ts") as typeof import("./seasonal.server"), ...db };
}
const ctxOf = (userId: string): AuthContext => { const u = USERS.find((x) => x.id === userId)!; return { userId, role: u.role, username: userId, groupId: u.groupId, designation: null } as unknown as AuthContext; };
const SO1 = ctxOf("so1"), SO2 = ctxOf("so2"), SO3 = ctxOf("so3"), RM1 = ctxOf("rm1"), ADMIN = ctxOf("admin");
const status = async (fn: () => Promise<unknown>) => { try { await fn(); return 0; } catch (e) { return (e as { status?: number }).status ?? -1; } };
const names = (o: { markets: { name: string }[] }) => o.markets.map((m) => m.name).join(" | ");

/** The Karuamor case: a name that exists ONLY as `marketText` (manual edit) — no Market record. Selectable, saved, revalidated, race-safe. */
async function territoryNameCases() {
  const { service, t, failMarketCreateOnce } = loadService();
  const sheet1 = await service.createSeasonalSheet(SO1, { seasonId: "s-kharif" });
  const sheet2 = await service.createSeasonalSheet(SO2, { seasonId: "s-kharif" });
  const auditBefore = t.audit.length, marketsBefore = JSON.stringify(t.markets), mappingsBefore = JSON.stringify(t.mappings);
  const opts = await service.listSeasonalMarketOptions(SO1, sheet1.id);
  const nowhere = opts.markets.find((m) => m.name === "Nowhere Mandi")!;
  assert.ok(nowhere && nowhere.id === null && nowhere.territoryMappingId === "mp4", "offered with a territory reference, not a fake id");
  assert.ok(opts.markets.some((m) => m.name === "Boring Road" && m.id === "m-boring"), "…alongside the approved Vacant Market");
  assert.ok(JSON.stringify(t.markets) === marketsBefore && t.audit.length === auditBefore, "reading the choices wrote nothing");

  // another officer cannot use that mapping (their own dealers do not include it), whatever they send
  assert.equal(await status(() => service.createSeasonalPlan(SO2, { sheetId: sheet2.id, territoryMappingId: "mp4", expectedMarket: "Nowhere Mandi" })), 422, "so2 has no relationship to the mapping");
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp1", expectedMarket: "Karuamor" })), 409, "a mapping that shows an ordinary Market (no edited name) is not a territory-name selection");
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp-none", expectedMarket: "X" })), 422, "unknown mapping");
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp9", expectedMarket: "Deleted Dealer Market" })), 422, "a deleted dealer's mapping is not selectable");
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp4" })), 422, "the name is required (partial reference)");
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, marketId: "m-boring", territoryMappingId: "mp4", expectedMarket: "Nowhere Mandi" })), 422, "an id AND a reference together is ambiguous");
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp4", expectedMarket: "Free Typed Name" })), 409, "the name must still be the mapping's saved name — typed names are never accepted");
  assert.equal(t.plans.length + t.markets.length, 13, "refused saves wrote nothing (no plan, no Market)");
  t.mappings.find((m) => m.id === "mp4")!.marketText = "Renamed Mandi";
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp4", expectedMarket: "Nowhere Mandi" })), 409, "a mapping renamed since the dialog opened is revalidated");
  t.mappings.find((m) => m.id === "mp4")!.marketText = "Nowhere Mandi";
  const aOwner = t.assignments.find((a) => a.dealerId === "d4")!; aOwner.officerId = "so2";
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp4", expectedMarket: "Nowhere Mandi" })), 422, "a dealer reassigned away since the dialog opened is revalidated");
  assert.equal(t.markets.length, 13, "still no Market created by any refused save");
  aOwner.officerId = "so1";

  // the explicit save: creates the canonical Market once, plan + audit, metadata not invented
  const saved = await service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp4", expectedMarket: "  nowhere   mandi " });
  assert.deepEqual([saved.marketName, saved.type, saved.marketPotential, saved.ownerId], ["Nowhere Mandi", "Existing", null, "so1"], "the plan shows the territory name; Type derived from the Market (Existing); Potential unknown stays unknown");
  const made = t.markets.filter((m) => m.name === "Nowhere Mandi");
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].nameKey, made[0].source, made[0].potential, made[0].createdById], ["nowhere mandi", "EXISTING", null, "so1"]);
  assert.ok(t.audit.some((a) => a.entity === "market" && a.action === "CREATE") && t.audit.some((a) => a.entity === "seasonalPlan" && a.action === "CREATE"), "Market creation and plan creation are both audited");
  assert.equal(JSON.stringify(t.mappings), mappingsBefore, "territory mappings (and their history) are untouched");
  assert.equal(t.markets.find((m) => m.id === "m-old")!.name, "Old Underlying Name", "the old underlying Market is not renamed");
  const reload = await service.getSeasonalSheet(SO1, sheet1.id);
  assert.ok(reload.plans.some((p) => p.id === saved.id && p.marketName === "Nowhere Mandi"), "after reload the saved plan displays the correct name");
  const after = (await service.listSeasonalMarketOptions(SO1, sheet1.id)).markets.find((m) => m.name === "Nowhere Mandi")!;
  assert.ok(after.id === made[0].id && after.territoryMappingId === null, "once resolved, the choice is an ordinary Market option (still only this owner's)");
  assert.equal((await service.listSeasonalMarketOptions(SO2, sheet2.id)).markets.some((m) => m.name === "Nowhere Mandi"), false, "…and so2 still does not get it");
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp4", expectedMarket: "Nowhere Mandi" })), 409, "repeating the save does not add a second plan row");

  // reuse of an existing record by normalized name (metadata kept) — Karuamor-style, record created earlier by someone else
  t.markets.push({ id: "m-late", name: "Late Mandi", nameKey: "late mandi", potential: "C", source: "REQUESTED" });
  t.mappings.find((m) => m.id === "mp4")!.marketText = "LATE   mandi";
  const reused = await service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp4", expectedMarket: "late mandi" });
  assert.deepEqual([reused.marketName, reused.marketPotential, t.markets.filter((m) => m.nameKey === "late mandi").length], ["Late Mandi", "C", 1], "a normalized-name match is reused with its metadata; nothing duplicated");

  // concurrency: identical saves in parallel → one Market, one plan
  t.markets = t.markets.filter((m) => m.id !== "m-late"); t.plans = t.plans.filter((p) => p.marketId === "m-karuamor");
  t.mappings.find((m) => m.id === "mp4")!.marketText = "Parallel Mandi";
  const results = await Promise.all([1, 2, 3].map(() => status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp4", expectedMarket: "Parallel Mandi" }))));
  assert.equal(results.filter((r) => r === 0).length, 1, "exactly one of three parallel saves succeeds: " + results.join());
  assert.ok(results.filter((r) => r !== 0).every((r) => r === 409), "the others get a clean 409");
  assert.equal(t.markets.filter((m) => m.nameKey === "parallel mandi").length, 1, "one Market");
  assert.equal(t.plans.filter((p) => t.markets.find((m) => m.id === p.marketId)?.nameKey === "parallel mandi").length, 1, "one plan row");
  // a different owner creating the same new Market at the same moment (loses the unique-name race) is retried and reuses the winner's record
  t.mappings.find((m) => m.id === "mp4")!.marketText = "Photo Finish";
  failMarketCreateOnce();
  const retried = await service.createSeasonalPlan(SO1, { sheetId: sheet1.id, territoryMappingId: "mp4", expectedMarket: "Photo Finish" });
  assert.equal(t.markets.filter((m) => m.nameKey === "photo finish").length, 1, "the race loser did not create a second Market");
  assert.ok(retried.id && t.audit.filter((a) => a.entity === "market" && /Photo Finish/.test(a.summary ?? "")).length === 0, "the winner's Market was reused (the loser's rolled-back attempt left no audit row)");

  // Edit: change a row to a territory-name Market (validated like Add), and an id Market still works
  const first = t.plans.find((p) => p.marketId === "m-karuamor") ?? await service.createSeasonalPlan(SO1, { sheetId: sheet1.id, marketId: "m-karuamor" });
  t.mappings.find((m) => m.id === "mp4")!.marketText = "Edit Target";
  const edited = await service.updateSeasonalPlan(SO1, first.id, { territoryMappingId: "mp4", expectedMarket: "Edit Target" });
  assert.equal(edited.marketName, "Edit Target", "Edit can move a row to a territory-name Market");
  assert.equal(await status(() => service.updateSeasonalPlan(SO1, first.id, { territoryMappingId: "mp4", expectedMarket: "Wrong Name" })), 409, "Edit revalidates the saved name");
  assert.equal(await status(() => service.updateSeasonalPlan(SO2, first.id, { territoryMappingId: "mp4", expectedMarket: "Edit Target" })), 404, "another officer cannot edit the row");
  // history intact: approval workflow on a created row still works
  const sub = await service.submitSeasonalPlan(SO1, edited.id);
  assert.equal(sub.approvalStatus, "PENDING_RM", "submit → RM review is unchanged");
}

async function main() {
  const { service, t } = loadService();
  const sheet1 = await service.createSeasonalSheet(SO1, { seasonId: "s-kharif" });
  const sheet2 = await service.createSeasonalSheet(SO2, { seasonId: "s-kharif" });
  const sheet3 = await service.createSeasonalSheet(SO3, { seasonId: "s-kharif" });

  /* ---- who sees what: existing ∪ approved vacant; nothing else ---- */
  const so1 = await service.listSeasonalMarketOptions(SO1, sheet1.id);
  assert.equal(names(so1), "Boring Road | Karuamor | Nowhere Mandi | Pipariya", "so1: Karuamor (dealers d1/d2, also approved → ONE entry), Pipariya (d3's edited name), Boring Road (approved, no dealer)");
  assert.ok(!so1.markets.some((m) => ["Old Underlying Name"].includes(m.name)), "the old underlying name of an edited Market is not offered");
  assert.equal(JSON.stringify(so1.markets.map((m) => [m.name, m.id, m.territoryMappingId])), JSON.stringify([["Boring Road", "m-boring", null], ["Karuamor", "m-karuamor", null], ["Nowhere Mandi", null, "mp4"], ["Pipariya", "m-pip", null]]), "an edited name with no Market record IS offered — as a reference to the owner's persisted mapping (mp4), with no Market id");
  assert.equal(t.markets.length, 13, "listing created no Market");
  for (const excluded of ["Rewa", "Pending Market", "Rejected Market", "Global Only", "Reassigned Away", "Inactive Dealer Market", "Deleted Dealer Market", "Bareli"]) assert.ok(!so1.markets.some((m) => m.name === excluded), `so1 does not get "${excluded}"`);
  assert.equal(so1.markets.filter((m) => m.name === "Karuamor").length, 1, "de-duplicated");
  assert.equal(so1.markets.map((m) => m.name).join(), [...so1.markets.map((m) => m.name)].sort((a, b) => a.localeCompare(b)).join(), "sorted by name");

  const so2 = await service.listSeasonalMarketOptions(SO2, sheet2.id);
  assert.equal(names(so2), "Bareli | Reassigned Away | Rewa | Shared Mandi", "so2 (same group and RM as so1): own dealers' Markets (Bareli; d5 → Shared Mandi; reassigned d7 → Reassigned Away) and their own approved request (Rewa) — nothing of so1's");
  assert.ok(!so2.markets.some((m) => ["Karuamor", "Boring Road", "Pipariya"].includes(m.name)), "no team-scope leakage between officers of one group");
  assert.ok(so2.markets.some((m) => m.name === "Reassigned Away"), "a reassigned dealer's Market follows the CURRENT owner (d7 → so2)");
  assert.equal(names(await service.listSeasonalMarketOptions(SO3, sheet3.id)), "", "an officer with no dealers and no approved request has no choices (empty eligibility)");

  /* ---- shared market: each officer who independently qualifies sees it ---- */
  assert.ok(so2.markets.some((m) => m.name === "Shared Mandi"), "so2 qualifies for Shared Mandi (dealer d5 + their approved request r8)");
  t.requests.push({ id: "r9", requesterId: "so1", status: "APPROVED", marketId: "m-shared" });
  assert.ok((await service.listSeasonalMarketOptions(SO1, sheet1.id)).markets.some((m) => m.name === "Shared Mandi"), "a market shared by two officers appears for EACH officer who independently qualifies");
  t.requests.pop();

  /* ---- the endpoint resolves the owner from the authenticated user + the plan, never from the browser ---- */
  assert.equal(await status(() => service.listSeasonalMarketOptions(SO2, sheet1.id)), 404, "someone else's plan looks missing (no probing another officer's territory)");
  assert.equal(await status(() => service.listSeasonalMarketOptions(RM1, sheet1.id)), 404, "an RM does not get an SO's choices — they are not the owner");
  assert.equal(await status(() => service.listSeasonalMarketOptions(ADMIN, sheet1.id)), 403, "Admin does not plan");
  assert.equal(await status(() => service.listSeasonalMarketOptions(SO1, "nope")), 404);

  /* ---- create: only eligible Markets, whatever exists globally ---- */
  const forged = ["m-rewa", "m-pending", "m-rejected", "m-global", "m-bareli", "m-old", "m-deleted"];
  for (const marketId of forged) assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, marketId })), 422, `forged create with ${marketId} is refused`);
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, marketId: "does-not-exist" })), 422);
  assert.equal(t.plans.length, 0, "nothing was saved by the refused requests");
  const boring = await service.createSeasonalPlan(SO1, { sheetId: sheet1.id, marketId: "m-boring", ownerId: "so2" } as never);
  assert.deepEqual([boring.marketName, boring.ownerId, boring.type, boring.marketPotential], ["Boring Road", "so1", "New", "A"], "an approved Vacant Market (no dealer yet) can be planned; the browser's ownerId is ignored; Type / Potential are still derived from the Market");
  const kar = await service.createSeasonalPlan(SO1, { sheetId: sheet1.id, marketId: "m-karuamor" });
  assert.equal(kar.marketName, "Karuamor");
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, marketId: "m-karuamor" })), 409, "duplicate-per-plan prevention is unchanged");
  assert.equal(await status(() => service.createSeasonalPlan(SO3, { sheetId: sheet3.id, marketId: "m-karuamor" })), 422, "an officer with an empty territory cannot plan any Market");
  assert.equal(await status(() => service.createSeasonalPlan(SO2, { sheetId: sheet1.id, marketId: "m-bareli" })), 404, "another officer's plan cannot be written to");
  assert.equal(await status(() => service.createSeasonalPlan(SO1, { sheetId: sheet1.id, marketId: "m-pip" })), 0, "the EDITED name (Pipariya) is a valid choice for the dealer that now shows it");

  /* ---- update: a CHANGED Market must be eligible; an unchanged one stays valid ---- */
  for (const marketId of ["m-rewa", "m-global", "m-pending"]) assert.equal(await status(() => service.updateSeasonalPlan(SO1, boring.id, { marketId })), 422, `forged update to ${marketId} is refused`);
  assert.equal(t.plans.find((p) => p.id === boring.id)!.marketId, "m-boring", "the row kept its Market");
  assert.equal(await status(() => service.updateSeasonalPlan(SO1, boring.id, { marketId: "m-pip" })), 409, "Pipariya is already in this plan (duplicate guard still applies)");
  t.plans = t.plans.filter((p) => p.marketId !== "m-pip");
  assert.equal(await status(() => service.updateSeasonalPlan(SO1, boring.id, { marketId: "m-pip" })), 0, "changing to another eligible Market works");

  /* ---- refreshed choices: territory changes show up on the next open; saved rows are never re-validated ---- */
  t.requests.push({ id: "r10", requesterId: "so3", status: "APPROVED", marketId: "m-global" });
  assert.equal(names(await service.listSeasonalMarketOptions(SO3, sheet3.id)), "Global Only", "a final approval appears as soon as the list is fetched again");
  // historical: a saved row whose Market is no longer eligible stays readable and editable-in-place
  t.requests = t.requests.filter((r) => r.id !== "r1"); // so1's approved Boring Road request disappears from eligibility…
  t.plans.push({ id: "px", sheetId: sheet1.id, seasonId: "s-kharif", ownerId: "so1", marketId: "m-boring", ...{ approvalStatus: "APPROVED", rmDecidedById: "rm1", rmDecidedAt: new Date(), adminDecidedById: "admin", adminDecidedAt: new Date(), rejectionStage: null, rejectionReason: null, approvedMarketSource: "REQUESTED", approvedMarketPotential: "A", appointmentStatus: "PENDING", appointedAt: null }, createdAt: new Date(0), updatedAt: new Date(0) });
  assert.ok(!(await service.listSeasonalMarketOptions(SO1, sheet1.id)).markets.some((m) => m.name === "Boring Road"), "…so it is no longer offered");
  const detail = await service.getSeasonalSheet(SO1, sheet1.id);
  assert.ok(detail.plans.some((p) => p.id === "px" && p.marketName === "Boring Road" && p.approvalStatus === "APPROVED"), "the historical approved row is still listed with its saved data");
  const reviewer = await service.getSeasonalSheet(RM1, sheet1.id);
  assert.ok(reviewer.plans.some((p) => p.id === "px" && p.marketName === "Boring Road" && p.marketPotential === "A"), "RM review still shows the owner's saved Market and Potential");
  const draft = t.plans.find((p) => p.id === boring.id)!;
  assert.equal(await status(() => service.updateSeasonalPlan(SO1, boring.id, { marketId: draft.marketId })), 0, "saving a row with its unchanged Market is not blocked by later eligibility changes");
  await territoryNameCases();
  console.log("seasonal-market-scope.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
