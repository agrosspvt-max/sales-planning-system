/**
 * Territory Mapping service contracts: scope, Existing Dealers, Potential / Market mapping, Excel import (preview never writes, confirm
 * is transactional, dealers are never created), Add Market (SO → RM → Admin) and the duplicate guard. Runs the REAL service and the
 * REAL dealer resolver against an in-memory database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import * as XLSX from "xlsx";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";
import { parseTerritorySheet } from "@/lib/territory-mapping";

/* ------------------------------------------------ in-memory database ------------------------------------------------ */

type Row = Record<string, unknown>;
const USERS = [
  { id: "admin", name: "Admin", role: Role.SUPER_ADMIN, groupId: null },
  { id: "rm1", name: "RM One", role: Role.REGIONAL_MANAGER, groupId: "g1" },
  { id: "so1", name: "Officer One", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "so2", name: "Officer Two", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "rm2", name: "RM Two", role: Role.REGIONAL_MANAGER, groupId: "g2" },
  { id: "so3", name: "Officer Three", role: Role.SALES_OFFICER, groupId: "g2" },
];
const DEALERS: { id: string; name: string; status: string; owner: string; also?: string[] }[] = [
  { id: "d1", name: "ABC Traders", status: "ACTIVE", owner: "so1" },
  { id: "d2", name: "Sharma Fertilizers", status: "ACTIVE", owner: "so1" },
  { id: "d3", name: "Gupta Agency", status: "PENDING", owner: "so2" },
  { id: "d4", name: "Far Away Agro", status: "ACTIVE", owner: "so3" },
  { id: "d5", name: "Twin Name Stores", status: "ACTIVE", owner: "so1" },
  { id: "d6", name: "Twin Name Stores", status: "ACTIVE", owner: "so2" },
  { id: "d7", name: "Own RM Dealer", status: "ACTIVE", owner: "rm1" },
  // Current owner so3, but an older assignment to so1 was never closed: so1 must NOT see it (the current owner decides).
  { id: "d8", name: "Stale Assignment Co", status: "ACTIVE", owner: "so3", also: ["so1"] },
];
const OWNERS_AT_START = DEALERS.map((d) => [d.id, d.owner]);
const GROUPS = [{ id: "g1", name: "Madhya Pradesh" }, { id: "g2", name: "Uttar Pradesh" }];
// District master: g1 (Madhya Pradesh) Rajgarh / Sagar / Indore (inactive); g2 (Uttar Pradesh) Kannauj / Agra. "Raj Garh" is an approved alias of Rajgarh.
const DISTRICTS = [
  { id: "dist-raj", groupId: "g1", name: "Rajgarh", nameKey: "rajgarh", isActive: true }, { id: "dist-sagar", groupId: "g1", name: "Sagar", nameKey: "sagar", isActive: true },
  { id: "dist-indore", groupId: "g1", name: "Indore", nameKey: "indore", isActive: false },
  { id: "dist-kan", groupId: "g2", name: "Kannauj", nameKey: "kannauj", isActive: true }, { id: "dist-agra", groupId: "g2", name: "Agra", nameKey: "agra", isActive: true },
];
const DISTRICT_ALIASES = [{ districtId: "dist-raj", groupId: "g1", aliasKey: "raj garh" }];
const ALIASES = [{ systemDealerId: "d1", tallyName: "ABC TRADING CO (TALLY)", tallyKey: "abctradingcotally", createdAt: new Date(), id: "a1" }];

function makeDb() {
  const t = {
    mappings: [] as Row[], markets: [] as Row[], requests: [] as Row[], audit: [] as Row[], edits: [] as Row[],
    clock: 0, dealerWrites: 0, // any write to a Dealer table row would bump this
  };
  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;
  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as Row;
        if ("in" in c) return (c.in as unknown[]).includes(row[key]);
        if ("not" in c) return c.not === null ? row[key] !== null && row[key] !== undefined : row[key] !== c.not;
      }
      return (row[key] ?? null) === (cond ?? null);
    });
  };
  const marketById = (mid: unknown) => t.markets.find((m) => m.id === mid);
  const districtById = (did: unknown) => DISTRICTS.find((d) => d.id === did);
  const withMarket = (m: Row) => ({ ...m, market: m.marketId ? { name: marketById(m.marketId)?.name } : null, districtRef: m.districtId ? { name: districtById(m.districtId)?.name, groupId: districtById(m.districtId)?.groupId } : null });
  const requester = (r: Row): Row & { requester: { name: string | undefined } } => ({ ...r, requester: { name: USERS.find((u) => u.id === r.requesterId)?.name } });
  let failNextMappingWrite = false;
  let failNextEdit = false;

  const prisma = {
    dealer: {
      findMany: async ({ where }: { where: Row }) => DEALERS.filter((d) => {
        if (where.isActive === true && d.id === "dead") return false;
        const some = (where.assignments as { some: { officerId: { in: string[] } } } | undefined)?.some;
        return !some || some.officerId.in.includes(d.owner) || (d.also ?? []).some((o) => some.officerId.in.includes(o));
      }).map(({ owner: _o, also: _a, ...d }) => ({ ...d, isActive: true })),
      findFirst: async ({ where }: { where: { id: string } }) => { const d = DEALERS.find((x) => x.id === where.id); return d ? { id: d.id, name: d.name, status: d.status } : null; },
    },
    dealerAlias: { findMany: async ({ where }: { where?: { systemDealerId?: { in: string[] } } }) => ALIASES.filter((a) => !where?.systemDealerId || where.systemDealerId.in.includes(a.systemDealerId)) },
    user: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => USERS.filter((u) => where.id.in.includes(u.id)) },
    userGroup: { findMany: async ({ where }: { where?: { id?: { in: string[] } } } = {}) => GROUPS.filter((g) => !where?.id || where.id.in.includes(g.id)) },
    district: {
      findMany: async ({ where }: { where?: Row } = {}) => DISTRICTS.filter((d) => matches(d as Row, where)).map((d) => ({ ...d })),
      findUnique: async ({ where }: { where: Row }) => { const d = DISTRICTS.find((x) => matches(x as Row, where)); return d ? { ...d } : null; },
    },
    districtAlias: { findMany: async () => DISTRICT_ALIASES.map((a) => ({ ...a })) },
    market: {
      findMany: async ({ where }: { where?: Row } = {}) => t.markets.filter((m) => matches(m, where)).map((m) => ({ ...m })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
      findUnique: async ({ where }: { where: Row }) => { const m = t.markets.find((x) => matches(x, where)); return m ? { ...m } : null; },
      create: async ({ data }: { data: Row }) => { const row = { id: id("m"), potential: null, expectedParties: null, ...data, createdAt: new Date() }; t.markets.push(row); return { ...row }; },
    },
    dealerMarketMapping: {
      findMany: async ({ where }: { where?: Row } = {}) => t.mappings.filter((m) => matches(m, where)).map(withMarket),
      findUnique: async ({ where }: { where: Row }) => { const m = t.mappings.find((x) => matches(x, where)); return m ? withMarket(m) : null; },
      upsert: async ({ where, update, create }: { where: Row; update: Row; create: Row }) => {
        if (failNextMappingWrite) { failNextMappingWrite = false; throw new Error("boom"); }
        const existing = t.mappings.find((x) => matches(x, where));
        if (existing) { Object.assign(existing, update); return { ...existing }; }
        const row = { id: id("map"), marketId: null, potential: null, district: null, districtId: null, ...create }; t.mappings.push(row); return { ...row };
      },
      createMany: async ({ data }: { data: Row[] }) => {
        if (failNextMappingWrite) { failNextMappingWrite = false; throw new Error("boom"); }
        for (const d of data) t.mappings.push({ id: id("map"), potential: null, district: null, districtId: null, ...d }); return { count: data.length };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => { const m = t.mappings.find((x) => matches(x, where))!; Object.assign(m, data); return { ...m }; },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => { const hit = t.mappings.filter((x) => matches(x, where)); hit.forEach((m) => Object.assign(m, data)); return { count: hit.length }; },
      create: async ({ data }: { data: Row }) => { const row = { id: id("map"), marketId: null, marketText: null, district: null, districtId: null, potential: null, ...data }; t.mappings.push(row); return { ...row }; },
    },
    territoryMarketEdit: {
      findMany: async ({ where, distinct }: { where: { dealerId: string | { in: string[] } }; distinct?: string[] }) => {
        const w = where.dealerId; const rows = t.edits.filter((e) => typeof w === "string" ? e.dealerId === w : w.in.includes(e.dealerId as string))
          .sort((a, b) => (a.editedAt as Date).getTime() - (b.editedAt as Date).getTime() || String(a.id).localeCompare(String(b.id)));
        const out = distinct ? rows.filter((r, i) => rows.findIndex((x) => x.dealerId === r.dealerId) === i) : rows;
        return out.map((e) => ({ ...e, editedBy: { name: USERS.find((u) => u.id === e.editedById)?.name } }));
      },
      create: async ({ data }: { data: Row }) => { if (failNextEdit) { failNextEdit = false; throw new Error("boom"); } const row = { id: id("edit"), editedAt: new Date(Date.UTC(2026, 9, 8, 12, 0, ++t.clock)), ...data }; t.edits.push(row); return { ...row }; },
    },
    marketRequest: {
      findFirst: async ({ where }: { where: Row }) => { const r = t.requests.find((x) => matches(x, where)); return r ? { ...r } : null; },
      create: async ({ data }: { data: Row }) => { const row = { id: id("req"), rmDecision: null, rmDecidedById: null, rmDecidedAt: null, adminDecision: null, adminDecidedById: null, adminDecidedAt: null, rejectionStage: null, rejectionReason: null, marketId: null, createdAt: new Date(), ...data }; t.requests.push(row); return requester(row); },
      findUnique: async ({ where }: { where: Row }) => { const r = t.requests.find((x) => matches(x, where)); return r ? requester(r) : null; },
      findMany: async ({ where }: { where: Row }) => t.requests.filter((r) => matches(r, where)).map(requester).sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()),
      update: async ({ where, data }: { where: Row; data: Row }) => { const r = t.requests.find((x) => matches(x, where))!; Object.assign(r, data); return requester(r); },
    },
    auditLog: { createMany: async ({ data }: { data: Row[] }) => { t.audit.push(...data); return { count: data.length }; } },
    // A real transaction: all-or-nothing. A failure restores the tables exactly as they were.
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      const snapshot = structuredClone([t.mappings, t.markets, t.requests, t.audit, t.edits]);
      try { return await fn(prisma); }
      catch (error) { const [m, k, r, a, e] = snapshot; t.mappings = m; t.markets = k; t.requests = r; t.audit = a; t.edits = e; throw error; }
    },
  };
  return { prisma, t, failNextMappingWrite: () => { failNextMappingWrite = true; }, failNextEdit: () => { failNextEdit = true; } };
}

/* ------------------------------------------------ service under test ------------------------------------------------ */

function loadService() {
  const db = makeDb();
  const owners = new Map(DEALERS.map((d) => [d.id, d.owner]));
  const getOfficerScope = async (ctx: AuthContext) => {
    if (ctx.role === Role.SUPER_ADMIN || ctx.role === Role.CUSTOM_ADMIN) return { all: true, ids: [] as string[] };
    if (ctx.role === Role.SALES_OFFICER) return { all: false, ids: [ctx.userId] };
    return { all: false, ids: [ctx.userId, ...USERS.filter((u) => u.role === Role.SALES_OFFICER && u.groupId === ctx.groupId).map((u) => u.id)] };
  };
  const load = testLoader({
    "@/lib/prisma": { prisma: db.prisma },
    "@/lib/http": { ApiError: TestApiError },
    "@/lib/audit": { writeAudit: async (p: Row) => { db.t.audit.push({ ...p }); } },
    "@/lib/scope": {
      getOfficerScope,
      getCurrentOwnerByDealer: async (ids: string[]) => new Map(ids.filter((i) => owners.has(i)).map((i) => [i, owners.get(i)!])),
      getCurrentManagerId: async (officerId: string) => { const me = USERS.find((u) => u.id === officerId); return USERS.find((u) => u.role === Role.REGIONAL_MANAGER && u.groupId === me?.groupId && u.id !== officerId)?.id ?? null; },
    },
  });
  const service = load("src/features/party-planning/territory.server.ts") as typeof import("./territory.server");
  return { service, ...db };
}

const ctxOf = (userId: string): AuthContext => { const u = USERS.find((x) => x.id === userId)!; return { userId, role: u.role, username: userId, groupId: u.groupId, designation: null } as unknown as AuthContext; };
const SO1 = ctxOf("so1"), SO2 = ctxOf("so2"), SO3 = ctxOf("so3"), RM1 = ctxOf("rm1"), RM2 = ctxOf("rm2"), ADMIN = ctxOf("admin");
const PAGE = { page: 1, pageSize: 100, search: "", market: "" };
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
async function status(fn: () => Promise<unknown>): Promise<number> { try { await fn(); return 0; } catch (e) { return (e as { status?: number }).status ?? -1; } }
function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const names = (rows: { partyName: string }[]) => rows.map((r) => r.partyName).sort();

async function main() {
  /* ---- Existing Dealers: everything in scope, nothing outside it ---- */
  {
    const { service } = loadService();
    const so1 = await service.listTerritoryDealers(SO1, PAGE);
    assert.deepEqual(names(so1.items), ["ABC TRADING CO (TALLY)", "Sharma Fertilizers", "Twin Name Stores"], "SO sees ALL own dealers (even with no Market), display name prefers the Tally alias");
    assert.deepEqual([so1.mapped, so1.unmapped], [0, 3], "unmapped dealers are included");
    assert.deepEqual(names((await service.listTerritoryDealers(RM1, PAGE)).items), ["ABC TRADING CO (TALLY)", "Gupta Agency", "Own RM Dealer", "Sharma Fertilizers", "Twin Name Stores", "Twin Name Stores"], "RM sees the whole group, not the other group");
    assert.equal((await service.listTerritoryDealers(ADMIN, PAGE)).total, 8, "Admin sees every dealer");
    assert.ok(!names((await service.listTerritoryDealers(SO1, PAGE)).items).includes("Stale Assignment Co"), "a dealer whose CURRENT owner is someone else is hidden even if a stale assignment remains");
    assert.ok(!names((await service.listTerritoryDealers(SO1, PAGE)).items).includes("Far Away Agro"), "an SO never sees another group's dealer");
    const row = (await service.listTerritoryDealers(SO1, PAGE)).items.find((r) => r.dealerId === "d2")!;
    assert.deepEqual([row.partyName, row.status, row.marketName, row.potential], ["Sharma Fertilizers", "ACTIVE", null, null], "Party Name + Status come from the dealer; Market/Potential start blank");
    assert.equal((await service.listTerritoryDealers(SO1, { ...PAGE, search: "sharma" })).total, 1, "search");
    assert.equal((await service.listTerritoryDealers(SO1, { ...PAGE, pageSize: 2 })).totalPages, 2, "pagination");
    assert.equal(await status(() => service.listTerritoryDealers({ ...SO1, role: undefined } as unknown as AuthContext, PAGE)), 403, "unknown roles are refused");
  }

  /* ---- Manual mapping: Market + Potential, scope enforced on write ---- */
  {
    const { service, t } = loadService();
    const market = await service.createMarketRequest(SO1, { marketName: "Pipariya", potential: "A", numberOfParties: 10 }); void market;
    t.markets.push({ id: "m-pip", name: "Pipariya", nameKey: "pipariya", potential: "A", source: "REQUESTED" });
    const set = await service.updateDealerMapping(SO1, "d1", { marketId: "m-pip", potential: "B" });
    assert.deepEqual([set.marketName, set.potential], ["Pipariya", "B"]);
    for (const p of ["A", "B", "C"] as const) assert.equal((await service.updateDealerMapping(SO1, "d1", { potential: p })).potential, p, `Potential ${p}`);
    assert.equal((await service.updateDealerMapping(SO1, "d1", { potential: null })).potential, null, "Potential can be cleared");
    assert.equal((await service.listTerritoryDealers(SO1, { ...PAGE, market: "m-pip" })).total, 1, "Market filter");
    assert.equal((await service.listTerritoryDealers(SO1, { ...PAGE, market: "__none__" })).total, 2, "Unmapped filter");
    assert.equal(t.markets.find((m) => m.id === "m-pip")!.potential, "A", "the dealer-level Potential never overwrites the Market's own potential");
    assert.equal(await status(() => service.updateDealerMapping(SO1, "d1", { potential: "Z" })), 422);
    assert.equal(await status(() => service.updateDealerMapping(SO1, "d1", { marketId: "nope" })), 422);
    assert.equal(await status(() => service.updateDealerMapping(SO1, "d1", {})), 422);
    assert.equal(await status(() => service.updateDealerMapping(SO1, "d3", { potential: "A" })), 403, "SO cannot map another officer's dealer");
    assert.equal(await status(() => service.updateDealerMapping(SO1, "d4", { potential: "A" })), 403, "nor another group's dealer");
    assert.equal(await status(() => service.updateDealerMapping(RM1, "d3", { potential: "A" })), 0, "RM can map a dealer of their team");
    assert.equal(await status(() => service.updateDealerMapping(RM1, "d4", { potential: "A" })), 403, "RM cannot map outside their group");
    assert.equal(await status(() => service.updateDealerMapping(ADMIN, "d4", { potential: "C" })), 0, "Admin can map any dealer");
    assert.equal(await status(() => service.updateDealerMapping(SO1, "missing", { potential: "A" })), 404);
    assert.ok(t.audit.some((a) => String(a.summary).includes("Market: — → Pipariya")), "changes are audited");
    assert.equal(t.dealerWrites, 0, "the Dealer record itself is never written");
  }

  /* ---- Excel import ---- */
  {
    const sheet = [["Dealer", "Market"], ["  abc   TRADERS ", "Pipariya"], ["ABC Trading Co (Tally)", "Pipariya"], ["Sharma Fertilizers", "pipariya"], ["Gupta Agency", "Bareli"], ["Nobody At All", "Bareli"], ["Twin Name Stores", "Bareli"], ["", "Bareli"], ["Far Away Agro", "Bareli"]];
    const { service, t } = loadService();
    const file = workbook({ Notes: [["hello"]], Mapping: sheet });
    // Multi-sheet workbooks ask for the sheet first.
    const ask = plain(await service.previewTerritoryImport(SO1, file, null));
    assert.deepEqual([ask.needsSheet, ask.sheetNames], [true, ["Notes", "Mapping"]]);
    assert.ok(plain(await service.previewTerritoryImport(SO1, file, "Notes")).error, "a sheet without Dealer / Market columns is rejected");
    assert.equal(await status(() => service.previewTerritoryImport(SO1, file, "Nope")), 422);

    const before = JSON.stringify([t.mappings, t.markets, t.audit]);
    const preview = plain(await service.previewTerritoryImport(SO1, file, "Mapping"));
    assert.equal(JSON.stringify([t.mappings, t.markets, t.audit]), before, "PREVIEW WRITES NOTHING (no mappings, markets or audit)");
    const byRow = (n: number) => preview.plan.find((r) => r.rowNumber === n)!;
    assert.deepEqual([byRow(2).status, byRow(2).dealerId], ["MATCHED", "d1"], "case + whitespace + punctuation differences still match exactly");
    assert.deepEqual([byRow(3).status, byRow(3).dealerId], ["DUPLICATE", "d1"], "the DealerAlias (Tally) name resolves to the SAME dealer, so row 3 repeats row 2");
    assert.equal(byRow(4).status, "MATCHED");
    assert.equal(byRow(5).status, "INVALID", "Gupta Agency belongs to another officer → outside the SO's scope (not silently mapped)");
    assert.equal(byRow(6).status, "UNMATCHED");
    assert.equal(byRow(7).status, "AMBIGUOUS", "two dealers share that name");
    assert.deepEqual(byRow(7).candidates!.map((c) => c.dealerId).sort(), ["d5"], "…and only the dealer the caller may map is offered");
    assert.deepEqual([byRow(8).status, byRow(8).reason], ["INVALID", "Party Name is empty"]);
    assert.equal(byRow(9).status, "INVALID", "a dealer from another group is outside scope");
    // A near-miss name is only ever offered for review — never mapped automatically.
    const fuzzy = plain(await service.previewTerritoryImport(SO1, workbook({ S: [["Dealer", "Market"], ["Sharma Fertilizers Agency", "Bareli"]] }), null)).plan[0]!;
    assert.equal(fuzzy.status, "AMBIGUOUS", "fuzzy candidate → review required");
    assert.deepEqual(fuzzy.candidates!.map((c) => c.partyName), ["Sharma Fertilizers"]);
    assert.equal(fuzzy.dealerId, undefined);
    assert.equal(preview.plan.filter((r) => r.dealerId === "d1").length, 2);

    // Confirm without resolving the ambiguity: it is SKIPPED, never guessed.
    const result = await service.commitTerritoryImport(SO1, file, "Mapping", {});
    assert.deepEqual(plain(result), { applied: 2, noChange: 0, skippedUnmatched: 1, skippedAmbiguous: 1, rejectedInvalid: 3, duplicates: 1, marketsCreated: 1, skippedUnknownDistrict: 0 });
    assert.deepEqual(t.markets.map((m) => [m.name, m.source, m.potential]), [["Pipariya", "EXISTING", null]], "one Market for Pipariya/pipariya; potential stays undecided");
    assert.deepEqual(t.mappings.map((m) => [m.dealerId, m.marketId === t.markets[0]!.id]).sort(), [["d1", true], ["d2", true]]);
    assert.equal(t.dealerWrites, 0, "no dealer was created or edited");
    assert.ok(t.audit.some((a) => a.entity === "territoryMappingImport"), "the import itself is audited");

    // Resolving the ambiguity maps exactly the chosen dealer (picks outside the candidates are ignored).
    const ctx2 = loadService();
    const done = await ctx2.service.commitTerritoryImport(SO1, file, "Mapping", { 7: "d5", 3: "d4" });
    assert.equal(done.applied, 3);
    assert.deepEqual(ctx2.t.mappings.map((m) => m.dealerId).sort(), ["d1", "d2", "d5"], "a pick for a non-ambiguous row / foreign dealer changes nothing");

    // Re-importing the same file is a no-op for mapped rows and keeps a dealer-level Potential.
    const again = loadService();
    await again.service.updateDealerMapping(SO1, "d1", { potential: "C" });
    await again.service.commitTerritoryImport(SO1, file, "Mapping", {});
    assert.equal(again.t.mappings.find((m) => m.dealerId === "d1")!.potential, "C", "import never overwrites the dealer's Potential");
    const second = await again.service.commitTerritoryImport(SO1, file, "Mapping", {});
    assert.equal(second.applied, 0); assert.equal(second.noChange, 2);

    // Atomic: a failure part-way leaves NOTHING behind (no market, no mapping, no audit).
    const atomic = loadService();
    atomic.failNextMappingWrite();
    assert.equal(await status(() => atomic.service.commitTerritoryImport(SO1, file, "Mapping", {})), -1);
    assert.deepEqual([atomic.t.markets.length, atomic.t.mappings.length, atomic.t.audit.length], [0, 0, 0], "transaction rolled back");

    // Conflicts / duplicates inside the sheet.
    const messy = workbook({ S: [["Dealer", "Market"], ["Sharma Fertilizers", "Bareli"], ["Sharma Fertilizers", "Pipariya"], ["ABC Traders", "Bareli"], ["abc traders", "bareli"]] });
    const mp = plain(await service.previewTerritoryImport(SO1, messy, null));
    assert.deepEqual(mp.plan.map((r) => r.status), ["CONFLICT", "CONFLICT", "MATCHED", "DUPLICATE"]);
    // Admin / RM scope on import.
    assert.equal(plain(await service.previewTerritoryImport(RM1, file, "Mapping")).plan.find((r) => r.rowNumber === 5)!.status, "MATCHED", "an RM can map their team's dealer");
    assert.equal(plain(await service.previewTerritoryImport(ADMIN, file, "Mapping")).plan.find((r) => r.rowNumber === 9)!.status, "MATCHED", "Admin can map any dealer");
    assert.equal(await status(() => service.previewTerritoryImport({ ...SO1, role: undefined } as unknown as AuthContext, file, null)), 403, "an unknown role is refused");
  }

  /* ---- Excel import with the District master (District | Market | Party Name, legacy Dealer header accepted) ---- */
  {
    const sheet = [["Dealer", "Market", "District"], ["ABC Traders", "Pipariya", "Rajgarh"], ["Sharma Fertilizers", "Pipariya", "Rajgarh"], ["Twin Name Stores", "Bareli", "Sagar"], ["Gupta Agency", "Bareli", "Sagar"], ["Nobody", "Bareli", "Sagar"], ["Far Away Agro", "Bareli", "Kannauj"]];
    const file = workbook({ Notes: [["x"]], Mapping: sheet });
    const { service, t } = loadService();
    t.markets.push({ id: "m-pip", name: "Pipariya", nameKey: "pipariya", potential: "A", source: "REQUESTED" });
    // d1 already has the SAME Market + District (linked); d2 has an OLD free-text District and no Market; d5 has a Potential only.
    t.mappings.push({ id: "x1", dealerId: "d1", marketId: "m-pip", district: "Rajgarh", districtId: "dist-raj", potential: "B" }, { id: "x2", dealerId: "d2", marketId: null, district: "Old District", districtId: null, potential: null }, { id: "x5", dealerId: "d5", marketId: null, district: null, districtId: null, potential: "C" });
    const before = JSON.stringify([t.mappings, t.markets, t.audit]);
    const preview = plain(await service.previewTerritoryImport(SO1, file, "Mapping"));
    assert.equal(JSON.stringify([t.mappings, t.markets, t.audit]), before, "preview writes nothing");
    const row = (n: number) => preview.plan.find((r) => r.rowNumber === n)!;
    assert.deepEqual([row(2).status, row(2).action, row(2).districtAction, row(2).currentDistrict, row(2).currentMarket], ["MATCHED", "NO_CHANGE", "NO_CHANGE", "Rajgarh", "Pipariya"], "same District + Market → nothing to change");
    assert.deepEqual([row(3).action, row(3).districtAction, row(3).currentDistrict, row(3).districtName, row(3).districtId, row(3).marketChanged], ["MAP", "CHANGE", "Old District", "Rajgarh", "dist-raj", true], "dealer matched by the dealer resolver; the old free text is replaced by the master district, Market added");
    assert.deepEqual([row(4).status, row(4).dealerId, row(4).districtAction, row(4).currentMarket], ["AMBIGUOUS", undefined, undefined, undefined], "ambiguous dealer is not auto-applied");
    assert.equal(row(5).status, "INVALID"); assert.equal(row(6).status, "UNMATCHED"); assert.equal(row(7).status, "INVALID", "out-of-scope dealers stay rejected");
    assert.equal(row(5).excelDistrict, "Sagar");

    const res = await service.commitTerritoryImport(SO1, file, "Mapping", { 4: "d5" });
    assert.equal(res.applied, 2);
    const map = (id: string) => t.mappings.find((m) => m.dealerId === id)!;
    assert.deepEqual([map("d1").district, map("d1").potential], ["Rajgarh", "B"], "an already-matching dealer is untouched");
    assert.deepEqual([map("d2").district, map("d2").districtId, map("d2").marketId != null], ["Rajgarh", "dist-raj", true], "District (text + master id) + Market written on the existing mapping row");
    assert.deepEqual([map("d5").district, map("d5").districtId, map("d5").potential, map("d5").marketId != null], ["Sagar", "dist-sagar", "C", true], "the picked dealer gets District + Market and keeps its dealer-level Potential");
    assert.equal(t.mappings.filter((m) => m.dealerId === "d2").length, 1, "District lives on the existing mapping row (no second row)");
    assert.equal(t.markets.find((m) => m.id === "m-pip")!.potential, "A", "Market potential untouched");
    assert.ok(t.audit.some((a) => String(a.summary).includes("District: Old District → Rajgarh")), "District change audited");
    assert.equal(t.dealerWrites, 0);
    assert.equal(t.markets.length, 2, "only the Bareli Market (new in the sheet) was added; Pipariya reused");
    assert.deepEqual(plain(DEALERS.map((d) => [d.id, d.owner])), plain(OWNERS_AT_START), "dealer assignments are untouched");

    // Only District differs → only District is written; Market keeps its value.
    const only = loadService();
    only.t.markets.push({ id: "m-pip", name: "Pipariya", nameKey: "pipariya", potential: null, source: "EXISTING" });
    only.t.mappings.push({ id: "y1", dealerId: "d1", marketId: "m-pip", district: "Sagar", districtId: "dist-sagar", potential: null });
    const standard = workbook({ S: [["District", "Market", "Party Name"], ["Rajgarh", "Pipariya", "ABC Traders"]] });
    const d = plain(await only.service.previewTerritoryImport(SO1, standard, null)).plan[0]!;
    assert.deepEqual([d.action, d.marketChanged, d.districtChanged, d.excelDealer], ["CHANGE", false, true, "ABC Traders"], "the standard District | Market | Party Name sheet (any column order) works");
    await only.service.commitTerritoryImport(SO1, standard, null, {});
    assert.deepEqual([only.t.mappings[0]!.district, only.t.mappings[0]!.districtId, only.t.mappings[0]!.marketId], ["Rajgarh", "dist-raj", "m-pip"]);

    // Old two-column sheets still work and leave District alone; a blank District cell preserves the existing district.
    const old = loadService();
    old.t.mappings.push({ id: "z1", dealerId: "d1", marketId: null, district: "Keep", districtId: null, potential: null });
    await old.service.commitTerritoryImport(SO1, workbook({ S: [["Dealer", "Market"], ["ABC Traders", "Pipariya"]] }), null, {});
    assert.equal(old.t.mappings.find((m) => m.dealerId === "d1")!.district, "Keep", "Dealer | Market sheet leaves District unchanged");
    const blank = loadService();
    blank.t.mappings.push({ id: "b1", dealerId: "d1", marketId: null, district: "Sagar", districtId: "dist-sagar", potential: null });
    await blank.service.commitTerritoryImport(SO1, workbook({ S: [["District", "Market", "Party Name"], ["", "Pipariya", "ABC Traders"]] }), null, {});
    assert.deepEqual([blank.t.mappings[0]!.district, blank.t.mappings[0]!.districtId, blank.t.mappings[0]!.marketId != null], ["Sagar", "dist-sagar", true], "a blank District cell keeps the existing district; the Market still maps");
    assert.equal(plain(parseTerritorySheet([["Party Name", "Dealer", "Market"], ["P", "D", "M"]])).rows[0]!.dealer, "P", "Party Name wins when both headers exist");

    // Unknown / cross-state / alias / inactive / no-state districts: whole row decided BEFORE anything of it is written.
    const bad = loadService();
    bad.t.markets.push({ id: "m-pip", name: "Pipariya", nameKey: "pipariya", potential: null, source: "EXISTING" });
    const badFile = workbook({ S: [["District", "Market", "Party Name"],
      ["Nowhere", "Newtown", "ABC Traders"],            // 2 unknown
      ["Kannauj", "Newtown", "Sharma Fertilizers"],      // 3 belongs to Uttar Pradesh, dealer is Madhya Pradesh
      ["Raj Garh", "Pipariya", "Twin Name Stores"],     // 4 alias (ambiguous dealer → picked below)
      ["Indore", "Newtown", "Own RM Dealer"],           // 5 inactive
    ] });
    const bp = plain(await bad.service.previewTerritoryImport(RM1, badFile, null));
    const brow = (n: number) => bp.plan.find((r) => r.rowNumber === n)!;
    assert.equal(brow(2).status, "UNKNOWN_DISTRICT"); assert.ok(brow(2).reason!.includes("Unknown District"));
    assert.equal(brow(3).status, "INVALID"); assert.ok(brow(3).reason!.includes("Uttar Pradesh") && brow(3).reason!.includes("Madhya Pradesh"), "the mismatch names both states");
    assert.equal(brow(5).status, "INVALID"); assert.ok(brow(5).reason!.includes("inactive"));
    assert.equal(bp.summary!.unknownDistricts, 1);
    assert.equal(brow(4).status, "AMBIGUOUS", "the two same-named dealers still need a choice");
    const applied = await bad.service.commitTerritoryImport(RM1, workbook({ S: [["District", "Market", "Party Name"], ["Raj Garh", "Pipariya", "Own RM Dealer"], ["Nowhere", "Newtown", "ABC Traders"], ["Kannauj", "Newtown", "Sharma Fertilizers"]] }), null, {});
    assert.deepEqual([applied.applied, applied.skippedUnknownDistrict, applied.rejectedInvalid], [1, 1, 1]);
    const alias = bad.t.mappings.find((m) => m.dealerId === "d7")!;
    assert.deepEqual([alias.district, alias.districtId], ["Rajgarh", "dist-raj"], "an approved alias is stored as the canonical district");
    assert.equal(bad.t.mappings.filter((m) => m.dealerId === "d1" || m.dealerId === "d2").length, 0, "rows with a bad district wrote nothing — not even their Market");
    assert.equal(bad.t.markets.some((m) => m.nameKey === "newtown"), false, "no Market was created for a blocked row");
    const aliasPlan = plain(await bad.service.previewTerritoryImport(RM1, workbook({ S: [["District", "Market", "Party Name"], ["Raj Garh", "Pipariya", "Own RM Dealer"]] }), null)).plan[0]!;
    assert.deepEqual([aliasPlan.districtViaAlias, aliasPlan.districtName], [true, "Rajgarh"], "the preview says the spelling was matched to the canonical name");

    // A dealer whose state cannot be determined can't receive a district.
    const so2 = USERS.find((u) => u.id === "so2")!;
    so2.groupId = null;
    try {
      const nos = loadService();
      const np = plain(await nos.service.previewTerritoryImport(SO2, workbook({ S: [["District", "Market", "Party Name"], ["Rajgarh", "Pipariya", "Gupta Agency"]] }), null)).plan[0]!;
      assert.equal(np.status, "INVALID"); assert.ok(np.reason!.includes("state cannot be determined"));
    } finally { so2.groupId = "g1"; }

    // Listing + manual edit share the same scope rules as Market.
    const list = plain(await service.listTerritoryDealers(SO1, PAGE)).items.find((r) => r.dealerId === "d2")!;
    assert.equal(list.district, "Rajgarh");
    assert.equal(await status(() => service.commitTerritoryImport({ ...SO1, role: undefined } as unknown as AuthContext, file, "Mapping", {})), 403);
  }

  /* ---- District dropdown: state-specific options, server-side validation, explicit Save, audit ---- */
  {
    const { service, t } = loadService();
    t.markets.push({ id: "m-pip", name: "Pipariya", nameKey: "pipariya", potential: null, source: "EXISTING" });
    // State-specific options: active districts of the caller's state(s) only.
    const opts = async (c: AuthContext) => plain(await service.listDistrictOptions(c));
    assert.deepEqual(Object.keys(await opts(SO1)), ["g1"], "an SO gets only their own state");
    assert.deepEqual((await opts(SO1)).g1!.map((d) => d.name), ["Rajgarh", "Sagar"], "active districts only (Indore is inactive), sorted");
    assert.deepEqual(Object.keys(await opts(SO3)), ["g2"]);
    assert.deepEqual(Object.keys(await opts(RM1)), ["g1"], "an RM gets the states inside their scope");
    assert.deepEqual(Object.keys(await opts(ADMIN)).sort(), ["g1", "g2"], "an Admin gets every state that has districts");
    assert.equal(await status(() => service.listDistrictOptions({ ...SO1, role: undefined } as unknown as AuthContext)), 403);

    // Each row carries the dealer's resolved state (Dealer → current assignment → officer → UserGroup).
    const rows = plain(await service.listTerritoryDealers(ADMIN, PAGE)).items;
    const by = (id: string) => rows.find((r) => r.dealerId === id)!;
    assert.deepEqual([by("d1").stateId, by("d1").stateName, by("d4").stateId, by("d4").stateName], ["g1", "Madhya Pradesh", "g2", "Uttar Pradesh"]);
    assert.equal(by("d8").stateId, "g2", "the CURRENT owner decides the state, not a stale assignment");

    // Explicit save: pick → server validates → persists text + id → audit entry with old and new.
    const saved = plain(await service.updateDealerMapping(SO1, "d1", { districtId: "dist-raj" }));
    assert.deepEqual([saved.district, saved.districtId, saved.districtReview, saved.stateName], ["Rajgarh", "dist-raj", null, "Madhya Pradesh"]);
    assert.deepEqual([t.mappings[0]!.district, t.mappings[0]!.districtId], ["Rajgarh", "dist-raj"]);
    assert.ok(t.audit.some((a) => String(a.summary).includes("District: — → Rajgarh") && a.entityId === "d1"), "audit: old → new");
    const auditCount = t.audit.length;
    await service.updateDealerMapping(SO1, "d1", { districtId: "dist-raj" });
    assert.equal(t.audit.length, auditCount, "re-saving the same district is not a change (no audit entry)");
    await service.updateDealerMapping(SO1, "d1", { districtId: "dist-sagar" });
    assert.ok(t.audit.some((a) => String(a.summary).includes("District: Rajgarh → Sagar")));

    // The server — not the dropdown — enforces state, status, existence and scope, whatever the client sends.
    const writes = () => JSON.stringify(t.mappings);
    const snapshot = writes();
    assert.equal(await status(() => service.updateDealerMapping(SO1, "d1", { districtId: "dist-kan" })), 422, "a forged district id of ANOTHER state is rejected");
    assert.equal(await status(() => service.updateDealerMapping(SO1, "d1", { districtId: "dist-indore" })), 422, "inactive district rejected");
    assert.equal(await status(() => service.updateDealerMapping(SO1, "d1", { districtId: "does-not-exist" })), 422, "unknown id rejected");
    assert.equal(await status(() => service.updateDealerMapping(SO1, "d1", { district: "Sagar" } as never)), 422, "free text is no longer accepted");
    assert.equal(await status(() => service.updateDealerMapping(SO1, "d3", { districtId: "dist-raj" })), 403, "SO scope: another officer's dealer");
    assert.equal(await status(() => service.updateDealerMapping(SO3, "d1", { districtId: "dist-kan" })), 403, "an SO of another state cannot touch it");
    assert.equal(await status(() => service.updateDealerMapping(RM2, "d1", { districtId: "dist-raj" })), 403, "RM scope");
    assert.equal(writes(), snapshot, "every rejection left the mapping exactly as it was");
    assert.equal((await service.updateDealerMapping(RM1, "d2", { districtId: "dist-raj" })).districtId, "dist-raj", "an RM edits dealers inside their group");
    assert.equal((await service.updateDealerMapping(ADMIN, "d4", { districtId: "dist-kan" })).stateName, "Uttar Pradesh", "Super Admin may edit any dealer");
    assert.equal(await status(() => service.updateDealerMapping(ADMIN, "d4", { districtId: "dist-raj" })), 422, "…but the district must still belong to that dealer's state");
    const custom = (perms: Record<string, string[]>) => ({ ...ADMIN, role: Role.CUSTOM_ADMIN, permissions: perms } as unknown as AuthContext);
    assert.equal(await status(() => service.updateDealerMapping(custom({ partyPlanning: ["read"] }), "d4", { districtId: "dist-kan" })), 403, "a custom Admin needs the Party Planning manage grant");
    assert.equal((await service.updateDealerMapping(custom({ partyPlanning: ["read", "manage"] }), "d4", { districtId: "dist-agra" })).district, "Agra");

    // Clearing: explicit, allowed, audited, keeps Market + potential.
    t.mappings.find((m) => m.dealerId === "d1")!.marketId = "m-pip"; t.mappings.find((m) => m.dealerId === "d1")!.potential = "B";
    const cleared = plain(await service.updateDealerMapping(SO1, "d1", { districtId: null }));
    assert.deepEqual([cleared.district, cleared.districtId, cleared.marketId, cleared.potential], [null, null, "m-pip", "B"], "clearing removes only the district");
    assert.ok(t.audit.some((a) => String(a.summary).includes("District: Sagar → —")));

    // Legacy free text stays visible and is flagged; clearing it is audited too.
    t.mappings.push({ id: "L1", dealerId: "d5", marketId: null, district: "Raj-garh (old)", districtId: null, potential: null });
    const legacy = plain(await service.listTerritoryDealers(SO1, PAGE)).items.find((r) => r.dealerId === "d5")!;
    assert.deepEqual([legacy.district, legacy.districtId, legacy.districtReview], ["Raj-garh (old)", null, "LEGACY"], "unresolved legacy text remains visible and flagged for review");
    await service.updateDealerMapping(SO1, "d5", { districtId: null });
    assert.ok(t.audit.some((a) => String(a.summary).includes("District: Raj-garh (old) → —")), "the old legacy value is kept in the audit trail");

    // Reassignment to another state: the old district is NOT erased, it is flagged until corrected.
    t.mappings.push({ id: "W1", dealerId: "d4", marketId: null, district: "Rajgarh", districtId: "dist-raj", potential: null });
    t.mappings.splice(t.mappings.findIndex((m) => m.dealerId === "d4" && m.id !== "W1"), 1);
    const moved = plain(await service.listTerritoryDealers(ADMIN, PAGE)).items.find((r) => r.dealerId === "d4")!;
    assert.deepEqual([moved.district, moved.districtReview, moved.stateName], ["Rajgarh", "WRONG_STATE", "Uttar Pradesh"], "kept, flagged, and correctable");

    // No state → no assignment, with a clear reason; Market/Potential saves still work.
    const so2 = USERS.find((u) => u.id === "so2")!;
    so2.groupId = null;
    try {
      const ns = loadService();
      const stateless = plain(await ns.service.listTerritoryDealers(SO2, PAGE)).items.find((r) => r.dealerId === "d3")!;
      assert.deepEqual([stateless.stateId, stateless.stateName], [null, null]);
      assert.equal(await status(() => ns.service.updateDealerMapping(SO2, "d3", { districtId: "dist-raj" })), 422, "no state → no district can be assigned");
      assert.equal((await ns.service.updateDealerMapping(SO2, "d3", { potential: "A" })).potential, "A", "other mapping fields are unaffected");
      assert.deepEqual(plain(await ns.service.listDistrictOptions(SO2)), {}, "and no unrestricted district list is offered");
    } finally { so2.groupId = "g1"; }
    assert.equal(t.dealerWrites, 0, "dealers themselves are never written");
    assert.deepEqual(plain(DEALERS.map((d) => [d.id, d.owner])), plain(OWNERS_AT_START), "dealer assignments are untouched");
  }

  /* ---- TEMPORARY manual Market edit + append-only history ---- */
  {
    const { service, t } = loadService();
    t.markets.push({ id: "m-tun", name: "TUNDLA", nameKey: "tundla", potential: "A", source: "EXISTING" });
    t.mappings.push({ id: "e1", dealerId: "d1", marketId: "m-tun", marketText: null, district: "FIROZABAD", potential: "B" });
    const marketsBefore = JSON.stringify(t.markets);
    const shown = async (id = "d1") => plain(await service.listTerritoryDealers(SO1, PAGE)).items.find((r) => r.dealerId === id)!;
    assert.deepEqual([(await shown()).marketName, (await shown()).marketEdited], ["TUNDLA", false], "before any edit: no Edited indicator");
    // 1) first edit → one history row; current Market = the new value
    const first = plain(await service.editDealerMarket(SO1, "d1", { expectedMarket: "TUNDLA", market: "  FIROZABAD " }));
    assert.deepEqual([first.marketName, first.marketEdited, first.district, first.potential], ["FIROZABAD", true, "FIROZABAD", "B"], "district / potential untouched");
    assert.equal(t.edits.length, 1);
    assert.deepEqual([t.edits[0]!.previousMarket, t.edits[0]!.newMarket, t.edits[0]!.editedById, t.edits[0]!.editedAt instanceof Date], ["TUNDLA", "FIROZABAD", "so1", true]);
    assert.equal(JSON.stringify(t.markets), marketsBefore, "NO Market master record is created or changed by a manual edit");
    assert.equal(t.mappings[0]!.marketId, "m-tun", "the mapped Market master id (used by planning) is untouched");
    assert.deepEqual([(await shown()).marketName, (await shown()).marketEdited], ["FIROZABAD", true]);
    // 2) many edits, by different users, all kept in order
    await service.editDealerMarket(SO1, "d1", { expectedMarket: "FIROZABAD", market: "AGRA" });
    await service.editDealerMarket(RM1, "d1", { expectedMarket: "AGRA", market: "FATEHABAD" });
    await service.editDealerMarket(ADMIN, "d1", { expectedMarket: "FATEHABAD", market: "SHIKOHABAD" });
    const hist = plain(await service.listMarketEdits(SO1, "d1"));
    assert.deepEqual(hist.edits.map((e) => [e.previousMarket, e.newMarket, e.editedByName]), [["TUNDLA", "FIROZABAD", "Officer One"], ["FIROZABAD", "AGRA", "Officer One"], ["AGRA", "FATEHABAD", "RM One"], ["FATEHABAD", "SHIKOHABAD", "Admin"]], "every transition, chronological, with the editor");
    assert.ok(hist.edits.every((e) => !Number.isNaN(Date.parse(e.editedAt))) && hist.edits.every((e, i) => i === 0 || e.editedAt >= hist.edits[i - 1]!.editedAt), "timestamps present and ordered");
    assert.equal((await shown()).marketName, "SHIKOHABAD", "current Market = the latest confirmed value");
    assert.equal(hist.dealerName, "ABC TRADING CO (TALLY)", "shown with the same display name as the list (alias)");
    // 10 edits keep 10 records
    for (let i = 0; i < 6; i++) await service.editDealerMarket(SO1, "d1", { expectedMarket: i === 0 ? "SHIKOHABAD" : `M${i - 1}`, market: `M${i}` });
    assert.equal(plain(await service.listMarketEdits(SO1, "d1")).edits.length, 10);
    // rejected edits leave no history
    const n = t.edits.length;
    assert.equal(await status(() => service.editDealerMarket(SO1, "d1", { expectedMarket: "WRONG", market: "X" })), 409, "stale value → conflict (no wrong history)");
    assert.equal(await status(() => service.editDealerMarket(SO1, "d1", { expectedMarket: "M5", market: " m5 " })), 422, "same Market → nothing to record");
    assert.equal(await status(() => service.editDealerMarket(SO1, "d1", { expectedMarket: "M5", market: "   " })), 422);
    assert.equal(await status(() => service.editDealerMarket(SO1, "d1", { expectedMarket: "M5", market: "x".repeat(121) })), 422);
    assert.equal(t.edits.length, n, "cancelled / rejected edits write nothing");
    // append-only: the service has no way to alter or remove history
    const src = readFileSync("src/features/party-planning/territory.server.ts", "utf8");
    assert.ok(!/territoryMarketEdit\.(update|delete|upsert)/.test(src), "service only ever inserts history rows");
    assert.ok(readFileSync("prisma/migrations/20261008010000_territory_market_edits/migration.sql", "utf8").includes("TerritoryMarketEdit_no_update"), "database trigger blocks UPDATE / DELETE");
    // authorization (server-side)
    assert.equal(await status(() => service.editDealerMarket(SO1, "d3", { expectedMarket: null, market: "X" })), 403, "another officer's dealer");
    assert.equal(await status(() => service.editDealerMarket(SO1, "d4", { expectedMarket: null, market: "X" })), 403, "another group's dealer");
    assert.equal(await status(() => service.editDealerMarket(SO1, "missing", { expectedMarket: null, market: "X" })), 404);
    assert.equal(await status(() => service.listMarketEdits(SO1, "d3")), 403, "history is scoped too");
    assert.equal(await status(() => service.editDealerMarket({ ...SO1, role: undefined } as unknown as AuthContext, "d1", { expectedMarket: "M5", market: "X" })), 403);
    assert.equal(await status(() => service.editDealerMarket(RM1, "d3", { expectedMarket: null, market: "Team Market" })), 0, "an RM edits a team dealer (no mapping yet → created)");
    assert.equal(await status(() => service.editDealerMarket(RM1, "d4", { expectedMarket: null, market: "X" })), 403);
    assert.equal(t.mappings.find((m) => m.dealerId === "d3")!.marketId, null, "an unmapped dealer gets the text only — still no Market master link");
    // atomic: history and mapping succeed or fail together
    const fail = loadService();
    fail.t.mappings.push({ id: "f1", dealerId: "d1", marketId: null, marketText: "OLD", district: null, potential: null });
    fail.failNextEdit();
    assert.equal(await status(() => fail.service.editDealerMarket(SO1, "d1", { expectedMarket: "OLD", market: "NEW" })), -1);
    assert.deepEqual([fail.t.mappings[0]!.marketText, fail.t.edits.length, fail.t.audit.length], ["OLD", 0, 0], "a failing history write rolls the Market change back (and vice versa)");
  }

  /* ---- UI wiring of the temporary Market edit (source-level) ---- */
  {
    const ui = readFileSync("src/features/party-planning/territory-mapping-page.tsx", "utf8");
    const cell = ui.slice(ui.indexOf("function MarketCell"), ui.indexOf("function MarketHistoryDialog"));
    assert.equal((cell.match(/change\.mutate\(/g) ?? []).length, 1, "the only save path is the confirmation dialog's Confirm button");
    assert.ok(cell.includes("onClick={() => change.mutate()}") && cell.includes("T.confirm") && DEFAULT_LABELS["party_planning.territory.dialog.confirm_change"] === "Confirm Change", "Confirm Change button");
    assert.ok(cell.includes("setConfirming(true)") && ["{T.title}", "{T.currentMarket}", "{T.newMarket}", "{row.partyName}"].every((x) => cell.includes(x)) && DEFAULT_LABELS["party_planning.territory.dialog.change_title"] === "Change Market for this dealer?" && DEFAULT_LABELS["party_planning.territory.dialog.current_market"] === "Current Market" && DEFAULT_LABELS["party_planning.territory.dialog.new_market"] === "New Market", "Save only opens a confirmation naming dealer, current and new Market");
    assert.ok(cell.includes("onClick={() => setEditing(false)}") && cell.includes("onClick={() => setConfirming(false)}"), "Cancel (edit and confirmation) only closes — it does not call the save mutation");
    assert.ok(cell.includes("T.edited") && cell.includes("setHistory(true)") && DEFAULT_LABELS["party_planning.territory.badge.edited"] === "Edited" && DEFAULT_LABELS["party_planning.territory.history.title"] === "Market Edit History", "Edited indicator opens the history");
    assert.ok(!/aria-label=\{L\.market\} value=\{row\.marketId/.test(ui), "the Market dropdown is gone from the Existing Dealers rows");
    assert.ok(ui.includes("<DistrictCell") && !ui.includes("district: v.district"), "District editing goes through the explicit-Save dropdown, not a blur-saving text box");
    // Seasonal / Monthly keep their searchable Market selectors and never see the editable Market.
    const seasonal = readFileSync("src/features/party-planning/seasonal-planning-page.tsx", "utf8"), monthly = readFileSync("src/features/party-planning/monthly-planning-page.tsx", "utf8");
    assert.ok(seasonal.includes("seasonal-add-markets") && seasonal.includes("/api/territory-mapping/markets"), "Seasonal Market selector: datalist of the Market master");
    assert.ok(!seasonal.includes("MarketCell") && !monthly.includes("MarketCell") && !seasonal.includes("market-history") && !monthly.includes("market-history") && !monthly.includes("marketText"));
    for (const f of ["seasonal.server.ts", "monthly.server.ts"]) assert.ok(!readFileSync(`src/features/party-planning/${f}`, "utf8").includes("marketText"), `${f} never reads the manual override`);
  }

  /* ---- Excel import vs manual edits ---- */
  {
    const { service, t } = loadService();
    t.markets.push({ id: "m-tun", name: "Tundla", nameKey: "tundla", potential: null, source: "EXISTING" });
    t.mappings.push({ id: "g1", dealerId: "d1", marketId: "m-tun", marketText: "Agra", district: "Rajgarh", districtId: "dist-raj", potential: null });
    await service.editDealerMarket(SO1, "d1", { expectedMarket: "Agra", market: "Firozabad" });
    const editsBefore = t.edits.length;
    const sheetSame = workbook({ S: [["Dealer", "Market", "District"], ["ABC Traders", "Firozabad", "Rajgarh"]] });
    assert.equal(plain(await service.previewTerritoryImport(SO1, sheetSame, null)).plan[0]!.action, "NO_CHANGE", "the import compares against the DISPLAYED (edited) Market");
    const sheetNew = workbook({ S: [["Dealer", "Market", "District"], ["ABC Traders", "Tundla", "Rajgarh"]] });
    assert.equal(plain(await service.previewTerritoryImport(SO1, sheetNew, null)).plan[0]!.currentMarket, "Firozabad");
    await service.commitTerritoryImport(SO1, sheetNew, null, {});
    assert.equal(t.edits.length, editsBefore, "an Excel import never writes manual-edit history");
    const mapped = t.mappings.find((m) => m.dealerId === "d1")!;
    assert.deepEqual([mapped.marketId, mapped.marketText], ["m-tun", null], "an import-set Market replaces the manual override");
    const row = plain(await service.listTerritoryDealers(SO1, PAGE)).items.find((r) => r.dealerId === "d1")!;
    assert.deepEqual([row.marketName, row.marketEdited], ["Tundla", true], "the Edited indicator (history) remains — it is history, not state");
    assert.equal(plain(await service.listMarketEdits(SO1, "d1")).edits.length, 1, "history is preserved across the import");
    // District editing unchanged by Market history
    assert.equal((await service.updateDealerMapping(SO1, "d1", { districtId: "dist-sagar" })).district, "Sagar");
    assert.equal(t.edits.length, editsBefore, "District edits never touch Market history");
  }

  /* ---- Add Market request → RM → Admin ---- */
  {
    const { service, t } = loadService();
    const req = await service.createMarketRequest(SO1, { marketName: "  Pipariya ", potential: "A", numberOfParties: 12 });
    assert.deepEqual([req.status, req.marketName, req.potential, req.numberOfParties, req.requesterName], ["PENDING_RM", "Pipariya", "A", 12, "Officer One"], "an SO's request goes to their RM first");
    assert.equal(t.markets.length, 0, "no Market exists before approval");
    assert.deepEqual((await service.listMarkets(SO1)).length, 0, "…and none is usable");
    assert.deepEqual((await service.listMarketRequests(SO1, "mine")).map((r) => r.id), [req.id], "the requester sees their request and its status");
    assert.deepEqual((await service.listMarketRequests(RM1, "review")).map((r) => r.id), [req.id], "the RM review queue");
    assert.equal((await service.listMarketRequests(ADMIN, "review")).length, 0, "Admin is not asked yet");
    assert.equal((await service.listMarketRequests(RM2, "review")).length, 0, "another group's RM never sees it");
    assert.equal((await service.listMarketRequests(SO2, "review")).length, 0, "an SO reviews nothing");
    // Validation + duplicates (normalized), never merged.
    for (const bad of [{ marketName: "", potential: "A", numberOfParties: 3 }, { marketName: "X", potential: "D", numberOfParties: 3 }, { marketName: "X", potential: "A", numberOfParties: 0 }, { marketName: "X", potential: "A", numberOfParties: 2.5 }]) assert.equal(await status(() => service.createMarketRequest(SO1, bad)), 422);
    assert.equal(await status(() => service.createMarketRequest(SO2, { marketName: "PIPARIYA", potential: "B", numberOfParties: 3 })), 409, "a pending request with the same normalized name blocks a duplicate");
    assert.equal(await status(() => service.createMarketRequest(ADMIN, { marketName: "Z", potential: "A", numberOfParties: 3 })), 403, "Admin does not file requests");

    // RM and Admin rejection both need a reason.
    assert.equal(await status(() => service.actOnMarketRequest(RM1, req.id, { action: "reject" })), 422, "RM rejection requires a reason");
    assert.equal(await status(() => service.actOnMarketRequest(RM1, req.id, { action: "reject", reason: "   " })), 422);
    assert.equal(await status(() => service.actOnMarketRequest(RM2, req.id, { action: "approve" })), 403, "an RM outside the team cannot review it");
    assert.equal(await status(() => service.actOnMarketRequest(SO1, req.id, { action: "approve" })), 403);
    assert.equal(await status(() => service.actOnMarketRequest(ADMIN, req.id, { action: "approve" })), 409, "Admin cannot skip the RM step");
    const rmApproved = await service.actOnMarketRequest(RM1, req.id, { action: "approve" });
    assert.deepEqual([rmApproved.status, rmApproved.rmDecidedByName != null, rmApproved.rmDecidedAt != null], ["PENDING_ADMIN", true, true], "RM approval moves it to Admin review and is recorded");
    assert.equal(t.markets.length, 0, "still not a Market after the RM step");
    assert.equal(await status(() => service.actOnMarketRequest(RM1, req.id, { action: "approve" })), 409, "the RM step cannot be repeated");
    assert.equal(await status(() => service.actOnMarketRequest(ADMIN, req.id, { action: "reject" })), 422, "Admin rejection requires a reason");
    const approved = await service.actOnMarketRequest(ADMIN, req.id, { action: "approve" });
    assert.deepEqual([approved.status, approved.adminDecidedByName, approved.marketId != null], ["APPROVED", "Admin", true]);
    assert.deepEqual(t.markets.map((m) => [m.name, m.potential, m.source, m.expectedParties]), [["Pipariya", "A", "REQUESTED", 12]], "final approval creates the Market");
    assert.deepEqual((await service.listMarkets(SO1)).map((m) => m.name), ["Pipariya"], "the approved Market is now available");
    assert.equal(await status(() => service.createMarketRequest(SO1, { marketName: "pipariya", potential: "C", numberOfParties: 4 })), 409, "an existing Market blocks a duplicate request");
    assert.deepEqual(t.audit.filter((a) => a.entity === "marketRequest" || a.entity === "market").map((a) => a.entity), ["marketRequest", "marketRequest", "market"], "request, RM decision and final approval are each audited");

    // Rejections keep who / when / why.
    const r2 = await service.createMarketRequest(SO1, { marketName: "Bareli", potential: "B", numberOfParties: 5 });
    const rmRej = await service.actOnMarketRequest(RM1, r2.id, { action: "reject", reason: "Too small" });
    assert.deepEqual([rmRej.status, rmRej.rejectionStage, rmRej.rejectionReason, rmRej.rmDecidedByName], ["REJECTED", "RM", "Too small", "RM One"]);
    assert.equal(t.markets.length, 1, "a rejected request creates no Market");
    const r3 = await service.createMarketRequest(SO1, { marketName: "Bareli", potential: "B", numberOfParties: 5 });
    await service.actOnMarketRequest(RM1, r3.id, { action: "approve" });
    const adminRej = await service.actOnMarketRequest(ADMIN, r3.id, { action: "reject", reason: "Duplicate territory" });
    assert.deepEqual([adminRej.status, adminRej.rejectionStage, adminRej.rejectionReason, adminRej.adminDecidedByName], ["REJECTED", "ADMIN", "Duplicate territory", "Admin"]);
    assert.equal((await service.listMarketRequests(SO1, "history")).length, 3, "history keeps every decided request with its reasons");
    // An RM's own request skips the RM step; a SO with no RM goes straight to Admin.
    const rmReq = await service.createMarketRequest(RM1, { marketName: "Chhindwara", potential: "C", numberOfParties: 8 });
    assert.equal(rmReq.status, "PENDING_ADMIN");
    assert.equal(await status(() => service.actOnMarketRequest(RM1, rmReq.id, { action: "approve" })), 409, "an RM cannot approve their own request");
    assert.deepEqual((await service.listMarketRequests(ADMIN, "review")).map((r) => r.marketName), ["Chhindwara"]);
    const lonely = await service.createMarketRequest(SO3, { marketName: "Rewa", potential: "A", numberOfParties: 2 });
    assert.equal(lonely.status, "PENDING_RM", "SO3's RM exists (rm2) → RM first");
    void SO2; void RM2;
  }
  /* ---- UI wiring: Territory Mapping is an ADDITION inside Party Planning; the appointment workflow is untouched ---- */
  {
    const page = readFileSync("src/features/party-planning/party-planning-page.tsx", "utf8");
    assert.ok(page.includes('href: "/planning/party/territory"') && !page.includes('labelKey: "party_planning.nav.create_plan"') && page.includes('{ key: "view", href: "/planning/party/view"'), "Territory Mapping | Planning | View; no Create Plan item");
    assert.ok(page.includes("export function PartyCreatePlanPage") && page.includes("export function PartyViewPage") && page.includes("/api/party-plans/save-draft"), "the appointment plan pages are still there");
    const ui = readFileSync("src/features/party-planning/territory-mapping-page.tsx", "utf8");
    for (const needle of ['"party_planning.territory.tab_existing"', '"party_planning.territory.tab_add_market"', "/api/territory-mapping/import/preview", "/api/territory-mapping/import/commit", "party_planning.territory.action.send_request"]) assert.ok(ui.includes(needle), needle);
    assert.ok(ui.indexOf("territory.col.market") < ui.indexOf("territory.col.potential") && ui.indexOf("territory.col.potential") < ui.indexOf("territory.col.party_name") && ui.indexOf("territory.col.party_name") < ui.indexOf("territory.col.status"), "columns: Market | Potential | Party Name | Status");
    assert.ok(readFileSync("src/app/(dashboard)/planning/party/territory/page.tsx", "utf8").includes("TerritoryMappingPage"));
    // The legacy free-text marketName columns were not migrated or altered.
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    assert.ok(/model PartyPlan[\s\S]*?marketName\s+String\?/.test(schema));
    const migration = readFileSync("prisma/migrations/20261007000000_territory_mapping/migration.sql", "utf8");
    assert.ok(!/^\s*(UPDATE|DELETE FROM|DROP|TRUNCATE)\b/im.test(migration) && !/ALTER TABLE "(?!DealerMarketMapping"|MarketRequest")/.test(migration), "the migration only creates new tables — no existing data is altered");
  }
  console.log("territory.test.ts — all assertions passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
