/**
 * Standalone filter scope against a REAL, disposable PostgreSQL database: Territory Mapping (State → Sales Officer → Market) and Payments (State → Sales Officer). Choices and results are both
 * constrained by the caller's authorized scope; a forged / incompatible parent value can only narrow, never widen.
 *
 *   BILLING_TASK_TEST_URL=postgresql://localhost:5432/billing_task_test npm run test:filter-scope:db
 */
import assert from "node:assert/strict";
import { PrismaClient, Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

const url = process.env.BILLING_TASK_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/billing_task_test")
  throw new Error("Only a local database named billing_task_test is permitted (set BILLING_TASK_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
const scopeStub = {
  getOfficerScope: async (c: AuthContext) => {
    if (c.role === Role.SUPER_ADMIN) return { all: true, ids: [] };
    if (c.role === Role.REGIONAL_MANAGER && c.groupId) return { all: false, ids: [c.userId, ...(await prisma.user.findMany({ where: { role: Role.SALES_OFFICER, groupId: c.groupId, isActive: true, deletedAt: null }, select: { id: true } })).map((u) => u.id)] };
    return { all: false, ids: [c.userId] };
  },
  getCurrentOwnerByDealer: async (ids: string[]) => { const rows = await prisma.dealerAssignment.findMany({ where: { dealerId: { in: ids }, effectiveTo: null }, orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }] }); return new Map(rows.map((r) => [r.dealerId, r.officerId])); },
  getCurrentDealerIds: async () => [], assertOfficerInScope: async () => undefined,
};
const load = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => ({}) }, "@/lib/scope": scopeStub,
  "@/features/sales-upload/alias.server": { listDealersForAlias: async () => ({ counts: {}, dealers: [] }) },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map(), resolveDealerDisplayNames: async () => new Map(), decorateDealerNames: async (r: unknown[]) => r, dealerDisplayName: (n: string) => n },
});
const territory = load<typeof import("./territory.server")>("src/features/party-planning/territory.server.ts");
const payments = load<typeof import("@/features/schemes/scheme-payments.server")>("src/features/schemes/scheme-payments.server.ts");
const ctx = (userId: string, role: Role, groupId: string | null): AuthContext => ({ userId, username: userId, role, groupId }) as AuthContext;
const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "DealerStatusRequest","DealerSchemePlan","Scheme","DealerMarketMapping","Market","DealerAssignment","Dealer","AuditLog","User","UserGroup" CASCADE`);
  await prisma.userGroup.createMany({ data: [{ id: "g1", name: "MP" }, { id: "g2", name: "UP" }] });
  const mk = (id: string, name: string, role: Role, groupId: string | null) => prisma.user.create({ data: { id, name, username: id, passwordHash: "x", role, groupId } as never });
  await mk("admin", "Admin", Role.SUPER_ADMIN, null); await mk("rm1", "Rita", Role.REGIONAL_MANAGER, "g1"); await mk("rm2", "Ravi", Role.REGIONAL_MANAGER, "g2");
  await mk("so1", "Bina", Role.SALES_OFFICER, "g1"); await mk("so2", "Anil", Role.SALES_OFFICER, "g1"); await mk("so3", "Chetan", Role.SALES_OFFICER, "g2");
  for (const [id, owner] of [["d1", "so1"], ["d2", "so1"], ["d3", "so2"], ["d4", "so3"], ["d5", "so2"]] as const) { await prisma.dealer.create({ data: { id, name: `Dealer ${id}` } }); await prisma.dealerAssignment.create({ data: { dealerId: id, officerId: owner, effectiveFrom: new Date("2024-01-01") } }); }
  for (const [id, name] of [["m1", "Birra"], ["m2", "Korba"], ["m3", "Sagar"], ["m4", "Unused"]] as const) await prisma.market.create({ data: { id, name, nameKey: name.toLowerCase(), source: "EXISTING" } as never });
  for (const [dealerId, marketId] of [["d1", "m1"], ["d2", "m1"], ["d3", "m2"], ["d4", "m3"]] as const) await prisma.dealerMarketMapping.create({ data: { dealerId, marketId } as never });
  const ADMIN = ctx("admin", Role.SUPER_ADMIN, null), RM1 = ctx("rm1", Role.REGIONAL_MANAGER, "g1"), RM2 = ctx("rm2", Role.REGIONAL_MANAGER, "g2"), SO1 = ctx("so1", Role.SALES_OFFICER, "g1");
  const names = (l: { name: string }[]) => l.map((m) => m.name);

  /* ---- Territory Mapping: State → Sales Officer → Market ---- */
  same(names(await territory.listMarketFilterChoices(ADMIN, {})), ["Birra", "Korba", "Sagar"], "All / All: every Market with a dealer in the caller's scope (not the whole master)");
  same(names(await territory.listMarketFilterChoices(ADMIN, { state: "g1" })), ["Birra", "Korba"], "State narrows the Markets");
  same(names(await territory.listMarketFilterChoices(ADMIN, { state: "g1", officer: "so2" })), ["Korba"], "Sales Officer narrows further");
  same(names(await territory.listMarketFilterChoices(ADMIN, { officer: "so3" })), ["Sagar"]);
  same(await territory.listMarketFilterChoices(ADMIN, { state: "g1", officer: "so3" }), [], "an officer outside the chosen State matches nothing (never widens)");
  same(names(await territory.listMarketFilterChoices(RM1, {})), ["Birra", "Korba"], "an RM's choices follow their team only");
  same(names(await territory.listMarketFilterChoices(RM1, { officer: "so1" })), ["Birra"]);
  assert.equal(await code(territory.listMarketFilterChoices(RM1, { officer: "so3" })), 403, "an RM cannot reach another State's officer");
  assert.equal(await code(territory.listMarketFilterChoices(RM1, { state: "g2" })), 403, "only an Admin filters by State");
  same(names(await territory.listMarketFilterChoices(RM2, {})), ["Sagar"], "another RM sees only their own team's Markets");
  same(names(await territory.listMarketFilterChoices(SO1, {})), ["Birra"], "an SO sees only their own dealers' Markets");
  assert.equal(await code(territory.listMarketFilterChoices(SO1, { officer: "so2" })), 403, "an SO cannot choose another officer");
  assert.equal(await code(territory.listMarketFilterChoices(SO1, { state: "g1" })), 403);
  // Results follow the same combined selections (and counts).
  const page = (c: AuthContext, p: Record<string, string>) => territory.listTerritoryDealers(c, { market: "", search: "", page: 1, pageSize: 25, ...p } as never);
  same((await page(ADMIN, { state: "g1" })).items.map((r) => r.dealerId), ["d1", "d2", "d3", "d5"].map((d) => `${d}`).sort(), "State g1: its dealers only");
  same((await page(ADMIN, { state: "g1", officer: "so2" })).items.map((r) => r.dealerId), ["d3", "d5"], "State + Sales Officer");
  same((await page(ADMIN, { state: "g1", officer: "so2", market: "m2" })).items.map((r) => r.dealerId), ["d3"], "State + Sales Officer + Market");
  same((await page(ADMIN, { state: "g1", officer: "so3" })).items, [], "incompatible State / officer → nothing");
  const counts = await page(ADMIN, { state: "g1", officer: "so2" });
  same([counts.mapped, counts.unmapped], [1, 1], "counts follow State + Sales Officer");
  assert.equal(await code(page(RM1, { officer: "so3" })), 403);
  assert.equal((await page(RM1, {})).items.every((r) => ["d1", "d2", "d3", "d5"].includes(r.dealerId)), true, "results obey the RM's scope");

  /* ---- Payments: State (id) → Sales Officer; options from the authorized plans; forged ids never broaden ---- */
  const scheme = await prisma.scheme.create({ data: { schemeName: "S1", schemeBenefit: "OTHER", createdById: "admin" } as never });
  for (const [dealerId, officer] of [["d1", "so1"], ["d3", "so2"], ["d4", "so3"]] as const)
    await prisma.dealerSchemePlan.create({ data: { schemeId: scheme.id, dealerId, salesOfficerId: officer, enrollmentStatus: "ENROLLED" } as never });
  const pay = (c: AuthContext, p: Record<string, string>) => payments.paymentDealers(c, payments.parsePaymentFilters(new URLSearchParams(p)));
  const all = await pay(ADMIN, {});
  same([all.rows.length, all.filters.states.map((s) => s.id), all.filters.officers.map((o) => o.name)], [3, ["g1", "g2"], ["Anil", "Bina", "Chetan"]], "All / All: the authorized set");
  const g1 = await pay(ADMIN, { stateId: "g1" });
  same([g1.rows.length, g1.filters.officers.map((o) => o.name), g1.filters.states.length], [2, ["Anil", "Bina"], 2], "a State narrows rows and Sales Officer choices; the State list is not collapsed by the selection");
  const so = await pay(ADMIN, { stateId: "g1", officerId: "so2" });
  same([so.rows.map((r) => r.salesOfficerName), so.filters.officers.length, so.filters.applied], [["Anil"], 2, { stateId: "g1", officerId: "so2" }], "choosing an officer does not shrink the officer choices");
  same((await pay(ADMIN, { stateId: "g1", officerId: "so3" })).filters.applied, { stateId: "g1", officerId: "" }, "an officer outside the State is dropped (applied filters are returned)");
  same((await pay(ADMIN, { stateId: "MP" })).filters.applied.stateId, "", "a State NAME is not an identity: ignored");
  const rm = await pay(RM1, {});
  same([rm.rows.length, rm.filters.states.map((s) => s.id), rm.filters.officers.map((o) => o.name)], [2, ["g1"], ["Anil", "Bina"]], "an RM's choices and rows are their team only");
  const forged = await pay(RM1, { officerId: "so3", stateId: "g2" });
  same([forged.rows.length, forged.rows.some((r) => r.salesOfficerId === "so3"), forged.filters.applied], [2, false, { stateId: "", officerId: "" }], "a forged officer / State from another team can never broaden an RM's result");
  const soOnly = await pay(ctx("so1", Role.SALES_OFFICER, "g1"), { officerId: "so2" });
  same([soOnly.rows.map((r) => r.salesOfficerId), soOnly.filters.officers.map((o) => o.id)], [["so1"], ["so1"]], "an SO who forges another officer id still sees only their own plans");
  /* ---- Territory Mapping → Request: Requested by multi-select (Admin tab), pending / resolved, identity = user id ---- */
  await prisma.user.update({ where: { id: "so1" }, data: { territory: "Raigarh" } });
  await prisma.user.update({ where: { id: "so2" }, data: { name: "Bina", territory: "Raigarh" } }); // same name AND same territory as so1
  await prisma.user.update({ where: { id: "so3" }, data: { territory: "Korba, Raigarh ,Korba" } });
  await prisma.user.update({ where: { id: "rm1" }, data: { territory: null } });
  const sr = (dealerId: string, by: string, role: Role, status: "PENDING" | "RESOLVED") => prisma.dealerStatusRequest.create({ data: { dealerId, statusAtRequest: "ACTIVE", reason: "INACTIVE", requestedById: by, requestedByRole: role, status, ...(status === "RESOLVED" ? { resolvedById: "admin", resolvedAt: new Date() } : {}) } as never });
  const q1 = await sr("d1", "so1", Role.SALES_OFFICER, "PENDING"), q2 = await sr("d3", "so2", Role.SALES_OFFICER, "PENDING"), q3 = await sr("d4", "so3", Role.SALES_OFFICER, "PENDING"), q4 = await sr("d2", "rm1", Role.REGIONAL_MANAGER, "PENDING");
  const q5 = await sr("d5", "so1", Role.SALES_OFFICER, "RESOLVED");
  const reqs = (c: AuthContext, view: "pending" | "resolved", requesterIds?: string[]) => territory.listDealerStatusRequestsFiltered(c, view, { requesterIds });
  const ids = (l: { items: { id: string }[] }) => l.items.map((r) => r.id).sort();
  const pending = await reqs(ADMIN, "pending");
  same(ids(pending), [q1.id, q2.id, q3.id, q4.id].sort(), "no selection (All): the full authorized list");
  same(pending.requesters.map((r) => [r.territory, r.name]), [["Korba, Raigarh", "Chetan"], ["Raigarh", "Bina"], ["Raigarh", "Bina"], [null, "Rita"]], "options: territory then name, no-territory last; two requesters with the same name AND territory stay two options");
  same(new Set(pending.requesters.map((r) => r.id)).size, 4, "identity is the user id");
  same(ids(await reqs(ADMIN, "pending", ["so1"])), [q1.id], "selecting ONE of two identical requesters filters only that requester");
  same(ids(await reqs(ADMIN, "pending", ["so1", "so3", "rm1"])), [q1.id, q3.id, q4.id].sort(), "several requesters: any of them (OR)");
  same(pending.items.find((r) => r.id === q4.id)!.requestedByTerritory, null, "no territory → null (the UI shows the fallback)");
  same(pending.items.find((r) => r.id === q3.id)!.requestedByTerritory, "Korba, Raigarh", "several territories: distinct names joined once each");
  // The other tab has its own authorized requesters; selections from the previous tab are dropped, never kept hidden.
  const resolved = await reqs(ADMIN, "resolved", ["so1", "so2", "so3"]);
  same([ids(resolved), resolved.requesters.map((r) => r.id), resolved.applied.requesterIds], [[q5.id], ["so1"], ["so1"]], "tab change: choices come from the resolved tab; invalid selections are removed, valid ones kept");
  same(ids(await reqs(ADMIN, "resolved")), [q5.id]);
  same((await reqs(ADMIN, "pending", ["bogus", "' OR 1=1", "so2"])).applied.requesterIds, ["so2"], "garbage ids are ignored");
  same(ids(await reqs(ADMIN, "pending", ["bogus"])), ids(pending), "an invalid-only selection filters nothing (no invisible filter hides every row)");
  // Role scoping is unchanged: Admin-only (a Custom Admin needs the manage permission).
  for (const who of [RM1, SO1, ctx("ca", Role.CUSTOM_ADMIN, null)]) assert.equal(await code(reqs(who, "pending")), 403, `${who.role} cannot list status requests`);
  // Resolve / edit are untouched by filtering.
  same((await prisma.dealerStatusRequest.findMany({ where: { status: "PENDING" } })).length, 4, "filtering changed no request");
  console.log("filter-scope.integration.ts — all scenarios passed");
}
main().then(async () => { await prisma.$disconnect(); }, async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
