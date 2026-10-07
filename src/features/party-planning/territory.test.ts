/**
 * Territory Mapping service contracts: scope, Existing Dealers, Potential / Market mapping, Excel import (preview never writes, confirm
 * is transactional, dealers are never created), Add Market (SO → RM → Admin) and the duplicate guard. Runs the REAL service and the
 * REAL dealer resolver against an in-memory database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Role } from "@prisma/client";
import * as XLSX from "xlsx";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

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
const ALIASES = [{ systemDealerId: "d1", tallyName: "ABC TRADING CO (TALLY)", tallyKey: "abctradingcotally", createdAt: new Date(), id: "a1" }];

function makeDb() {
  const t = {
    mappings: [] as Row[], markets: [] as Row[], requests: [] as Row[], audit: [] as Row[],
    dealerWrites: 0, // any write to a Dealer table row would bump this
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
  const withMarket = (m: Row) => ({ ...m, market: m.marketId ? { name: marketById(m.marketId)?.name } : null });
  const requester = (r: Row): Row & { requester: { name: string | undefined } } => ({ ...r, requester: { name: USERS.find((u) => u.id === r.requesterId)?.name } });
  let failNextMappingWrite = false;

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
        const row = { id: id("map"), marketId: null, potential: null, ...create }; t.mappings.push(row); return { ...row };
      },
      createMany: async ({ data }: { data: Row[] }) => {
        if (failNextMappingWrite) { failNextMappingWrite = false; throw new Error("boom"); }
        for (const d of data) t.mappings.push({ id: id("map"), potential: null, ...d }); return { count: data.length };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => { const m = t.mappings.find((x) => matches(x, where))!; Object.assign(m, data); return { ...m }; },
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
      const snapshot = structuredClone([t.mappings, t.markets, t.requests, t.audit]);
      try { return await fn(prisma); }
      catch (error) { const [m, k, r, a] = snapshot; t.mappings = m; t.markets = k; t.requests = r; t.audit = a; throw error; }
    },
  };
  return { prisma, t, failNextMappingWrite: () => { failNextMappingWrite = true; } };
}

/* ------------------------------------------------ service under test ------------------------------------------------ */

function loadService() {
  const db = makeDb();
  const owners = new Map(DEALERS.map((d) => [d.id, d.owner]));
  const getOfficerScope = async (ctx: AuthContext) => {
    if (ctx.role === Role.SUPER_ADMIN) return { all: true, ids: [] as string[] };
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
    assert.deepEqual([byRow(8).status, byRow(8).reason], ["INVALID", "Dealer is empty"]);
    assert.equal(byRow(9).status, "INVALID", "a dealer from another group is outside scope");
    // A near-miss name is only ever offered for review — never mapped automatically.
    const fuzzy = plain(await service.previewTerritoryImport(SO1, workbook({ S: [["Dealer", "Market"], ["Sharma Fertilizers Agency", "Bareli"]] }), null)).plan[0]!;
    assert.equal(fuzzy.status, "AMBIGUOUS", "fuzzy candidate → review required");
    assert.deepEqual(fuzzy.candidates!.map((c) => c.partyName), ["Sharma Fertilizers"]);
    assert.equal(fuzzy.dealerId, undefined);
    assert.equal(preview.plan.filter((r) => r.dealerId === "d1").length, 2);

    // Confirm without resolving the ambiguity: it is SKIPPED, never guessed.
    const result = await service.commitTerritoryImport(SO1, file, "Mapping", {});
    assert.deepEqual(plain(result), { applied: 2, noChange: 0, skippedUnmatched: 1, skippedAmbiguous: 1, rejectedInvalid: 3, duplicates: 1, marketsCreated: 1 });
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
    assert.ok(page.includes('href: "/planning/party/territory"') && page.includes('{ key: "create", href: "/planning/party"') && page.includes('{ key: "view", href: "/planning/party/view"'), "Territory Mapping | Create Plan | View live side by side");
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
