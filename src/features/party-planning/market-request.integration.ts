/**
 * Vacant-Market request workflow against a REAL, disposable PostgreSQL database (mocked Prisma cannot prove that columns, indexes or migrations exist).
 *
 *   createdb market_request_test && DATABASE_URL=postgresql://localhost:5432/market_request_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   MARKET_REQUEST_TEST_URL=postgresql://localhost:5432/market_request_test npm run test:market-requests:db
 *
 * Only a LOCAL database named `market_request_test` is permitted — the script TRUNCATEs the tables it uses.
 */
import assert from "node:assert/strict";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

const url = process.env.MARKET_REQUEST_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/market_request_test")
  throw new Error("Only a local database named market_request_test is permitted (set MARKET_REQUEST_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
let failAudit = false;
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => { if (failAudit) { failAudit = false; throw new Error("injected audit failure"); } return tx.auditLog.create({ data }); } },
  "@/features/sales-upload/alias.server": { listDealersForAlias: async () => ({ counts: {}, dealers: [] }) },
});
const svc = load("src/features/party-planning/territory.server.ts") as typeof import("./territory.server");
const ctx = (userId: string, role: Role, groupId: string | null) => ({ userId, role, username: userId, groupId, designation: null }) as unknown as AuthContext;
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: { status?: number }) => (e.status ? `409`.replace("409", String(e.status)) : "crash"));

async function main() {
  /* ---- the deployed schema actually has what the code needs (this is the check that catches "migration not applied") ---- */
  const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'MarketRequest'`);
  assert.ok(cols.some((c) => c.column_name === "districtId"), "MarketRequest.districtId exists (migration 20261012000000_market_request_district applied)");
  const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'MarketRequest'`);
  assert.ok(idx.some((i) => i.indexname === "MarketRequest_one_open_per_name"), "partial unique index exists (migration 20261012010000_market_request_pending_name_unique applied)");
  assert.ok((await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM information_schema.tables WHERE table_name = 'District'`)).length === 1, "District master table exists (prerequisite migration)");

  await prisma.$executeRawUnsafe(`TRUNCATE "MarketRequest","Market","AuditLog","District","User","UserGroup" CASCADE`);
  const st = await prisma.userGroup.create({ data: { name: "State A" } }), other = await prisma.userGroup.create({ data: { name: "State B" } });
  const balod = await prisma.district.create({ data: { groupId: st.id, name: "Balod", nameKey: "balod" } });
  const dormant = await prisma.district.create({ data: { groupId: st.id, name: "Dormant", nameKey: "dormant", isActive: false } });
  const foreign = await prisma.district.create({ data: { groupId: other.id, name: "Elsewhere", nameKey: "elsewhere" } });
  const mk = (u: string, role: Role, groupId: string | null) => prisma.user.create({ data: { passwordHash: "x", name: u, username: u, role, groupId } });
  const so = await mk("so", Role.SALES_OFFICER, st.id), rm = await mk("rm", Role.REGIONAL_MANAGER, st.id), admin = await mk("admin", Role.SUPER_ADMIN, null);
  const lone = await mk("lone", Role.SALES_OFFICER, other.id); // State B has no RM
  const SO = ctx(so.id, Role.SALES_OFFICER, st.id), RM = ctx(rm.id, Role.REGIONAL_MANAGER, st.id), ADMIN = ctx(admin.id, Role.SUPER_ADMIN, null), LONE = ctx(lone.id, Role.SALES_OFFICER, other.id);
  const body = (name: string, districtId = balod.id) => ({ districtId, marketName: name, potential: "A", numberOfParties: "3" }); // exactly what the form sends
  const counts = async () => ({ requests: await prisma.marketRequest.count(), markets: await prisma.market.count(), audits: await prisma.auditLog.count() });

  /* ---- submission, both roles, routing ---- */
  const soReq = await svc.createMarketRequest(SO, body("test"));
  assert.deepEqual([soReq.status, soReq.districtName], ["PENDING_RM", "Balod"], "SO → RM first");
  assert.equal((await svc.createMarketRequest(RM, body("rm own"))).status, "PENDING_ADMIN", "RM's own request → Admin");
  assert.equal((await svc.createMarketRequest(LONE, body("lonely", foreign.id))).status, "PENDING_ADMIN", "SO without an RM → Admin");
  assert.deepEqual(await counts(), { requests: 3, markets: 0, audits: 3 }, "three requests with their audit rows; NO Market yet");

  /* ---- rejected input saves nothing ---- */
  const before = await counts();
  for (const [why, b] of [["other State's district", body("x1", foreign.id)], ["inactive district", body("x2", dormant.id)], ["unknown district", body("x3", "nope")], ["no district", { ...body("x4"), districtId: undefined }], ["bad potential", { ...body("x5"), potential: "Z" }], ["zero parties", { ...body("x6"), numberOfParties: 0 }]] as const)
    assert.equal(await outcome(svc.createMarketRequest(SO, b)), "422", `${why} → 422`);
  assert.deepEqual(await counts(), before, "rejected submissions left nothing behind");
  assert.equal(await outcome(svc.createMarketRequest(ADMIN, body("by admin"))), "403");

  /* ---- double click / retry / concurrent submits: exactly one open request ---- */
  const burst = await Promise.all(Array.from({ length: 6 }, () => outcome(svc.createMarketRequest(SO, body("Burst")))));
  assert.equal(burst.filter((r) => r === "ok").length, 1, "one submit wins");
  assert.ok(burst.filter((r) => r !== "ok").every((r) => r === "409"), "the rest are conflicts (never crashes)");
  assert.equal(await prisma.marketRequest.count({ where: { nameKey: "burst" } }), 1, "one row, one audit");
  assert.equal(await prisma.auditLog.count({ where: { entity: "marketRequest", summary: { contains: "Burst" } } }), 1);

  /* ---- atomic submit: a failed audit write rolls the request back, and the retry works ---- */
  failAudit = true;
  await assert.rejects(() => svc.createMarketRequest(SO, body("Atomic")), /injected audit failure/);
  assert.equal(await prisma.marketRequest.count({ where: { nameKey: "atomic" } }), 0, "no request left behind");
  assert.equal((await svc.createMarketRequest(SO, body("Atomic"))).status, "PENDING_RM", "retry succeeds");

  /* ---- review: roles, order, atomic final approval ---- */
  assert.equal(await outcome(svc.actOnMarketRequest(SO, soReq.id, { action: "approve" })), "403", "SO cannot approve");
  assert.equal(await outcome(svc.actOnMarketRequest(ADMIN, soReq.id, { action: "approve" })), "409", "Admin cannot skip the RM stage");
  const rmOwn = (await prisma.marketRequest.findFirst({ where: { nameKey: "rm own" } }))!;
  assert.equal(await outcome(svc.actOnMarketRequest(RM, rmOwn.id, { action: "approve" })), "409", "RM cannot approve their own request");
  const viaRm = await svc.actOnMarketRequest(RM, soReq.id, { action: "approve" });
  assert.deepEqual([viaRm.status, viaRm.districtName], ["PENDING_ADMIN", "Balod"]);
  failAudit = true;
  await assert.rejects(() => svc.actOnMarketRequest(ADMIN, soReq.id, { action: "approve" }), /injected audit failure/);
  assert.deepEqual([await prisma.market.count(), (await prisma.marketRequest.findUnique({ where: { id: soReq.id } }))!.status], [0, "PENDING_ADMIN"], "failed final approval: no Market, still pending");
  const fin = await svc.actOnMarketRequest(ADMIN, soReq.id, { action: "approve" });
  const mkt = await prisma.market.findFirst({ where: { nameKey: "test" } });
  assert.deepEqual([fin.status, fin.districtName, fin.marketId === mkt?.id, await prisma.market.count()], ["APPROVED", "Balod", true, 1], "final approval: one Market, linked, district kept");

  /* ---- concurrent decisions: one winner, consistent result ---- */
  const dupe = await Promise.all([outcome(svc.actOnMarketRequest(ADMIN, rmOwn.id, { action: "approve" })), outcome(svc.actOnMarketRequest(ADMIN, rmOwn.id, { action: "approve" })), outcome(svc.actOnMarketRequest(ADMIN, rmOwn.id, { action: "approve" }))]);
  assert.deepEqual([dupe.filter((r) => r === "ok").length, dupe.filter((r) => r === "409").length], [1, 2], "three simultaneous approvals: one wins, two conflicts");
  assert.equal(await prisma.market.count({ where: { nameKey: "rm own" } }), 1, "exactly one Market");
  const contested = (await svc.createMarketRequest(RM, body("Contested")));
  const [a, r] = await Promise.all([outcome(svc.actOnMarketRequest(ADMIN, contested.id, { action: "approve" })), outcome(svc.actOnMarketRequest(ADMIN, contested.id, { action: "reject", reason: "no" }))]);
  const row = (await prisma.marketRequest.findUnique({ where: { id: contested.id } }))!;
  assert.deepEqual([a === "ok" || r === "ok", a === "ok" && r === "ok"], [true, false], "approve vs reject: exactly one succeeds");
  assert.equal(row.status === "APPROVED", (await prisma.market.count({ where: { nameKey: "contested" } })) === 1, "the Market exists exactly when the request ended APPROVED");
  assert.equal(row.status === "REJECTED" ? row.rejectionReason : null, row.status === "REJECTED" ? "no" : null);

  /* ---- rejection keeps the district; history; legacy request without district ---- */
  const rej = await svc.createMarketRequest(RM, body("To Reject"));
  assert.deepEqual((await svc.actOnMarketRequest(ADMIN, rej.id, { action: "reject", reason: "dup area" })).districtName, "Balod");
  await prisma.marketRequest.create({ data: { requesterId: so.id, marketName: "Old", nameKey: "old", potential: "B", numberOfParties: 2, status: "APPROVED", districtId: null } });
  const hist = await svc.listMarketRequests(ADMIN, "history");
  assert.equal(hist.find((h) => h.marketName === "Old")!.districtName, null, "a request from before the District field stays readable (no district)");
  assert.equal(hist.find((h) => h.id === rej.id)!.districtName, "Balod");
  /* ---- State / District / Requested By filters: parent State, OR within a column, AND between filters, scope-safe, no writes ---- */
  {
    const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
    await prisma.$executeRawUnsafe(`TRUNCATE "MarketRequest","Market","AuditLog" CASCADE`);
    const durg = await prisma.district.create({ data: { groupId: st.id, name: "durg", nameKey: "durg" } });
    const rajgarh = await prisma.district.create({ data: { groupId: st.id, name: "Rajgarh", nameKey: "rajgarh" } });
    const twinA = await mk("twinA", Role.SALES_OFFICER, st.id), twinB = await mk("twinB", Role.SALES_OFFICER, st.id);
    await prisma.user.updateMany({ where: { id: { in: [twinA.id, twinB.id] } }, data: { name: "Chittranjan" } });
    await prisma.user.update({ where: { id: twinA.id }, data: { territory: "Raigarh" } }); await prisma.user.update({ where: { id: twinB.id }, data: { territory: "Korba" } });
    const mkReq = (requesterId: string, marketName: string, districtId: string | null, status = "PENDING_ADMIN") => prisma.marketRequest.create({ data: { requesterId, marketName, nameKey: marketName.toLowerCase(), potential: "A", numberOfParties: 2, districtId, status } as never });
    const r1 = await mkReq(twinA.id, "M1", balod.id), r2 = await mkReq(twinA.id, "M2", durg.id), r3 = await mkReq(twinB.id, "M3", rajgarh.id), r4 = await mkReq(so.id, "M4", balod.id), r5 = await mkReq(lone.id, "M5", foreign.id);
    const legacy = await mkReq(so.id, "M6", null);
    const ids = (l: { items: { id: string }[] }) => l.items.map((r) => r.id).sort();
    const all = [r1.id, r2.id, r3.id, r4.id, r5.id, legacy.id].sort();
    const state = async () => JSON.stringify((await prisma.marketRequest.findMany({ orderBy: { id: "asc" } })).map((r) => [r.id, r.status, r.districtId, r.requesterId, r.marketId]));
    const snapshot = await state();

    const none = await svc.listMarketRequestsFiltered(ADMIN, "review");
    same(ids(none), all, "All States → the full authorized dataset (incl. a legacy request without a district)");
    same(none.states.map((x) => x.name), ["State A", "State B"], "State options: alphabetical, only States that have requests");
    same(none.districts.map((x) => x.name), ["Balod", "durg", "Elsewhere", "Rajgarh"], "District options: alphabetical (case-insensitive), deduplicated");
    same(none.requesters.map((x) => [x.territory, x.name]), [["Korba", "Chittranjan"], ["Raigarh", "Chittranjan"], [null, "lone"], [null, "so"]], "Requested By options: by territory, then name (no territory last); the territory is the requester's own");

    const a = await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id });
    same(ids(a), [r1.id, r2.id, r3.id, r4.id].sort(), "a State restricts the rows (by the DISTRICT's State; the legacy row has none)");
    same(a.districts.map((x) => x.name), ["Balod", "durg", "Rajgarh"], "…and the District choices");
    same(a.requesters.map((x) => x.id).sort(), [twinA.id, twinB.id, so.id].sort(), "…and the Requested By choices (no requester from State B)");
    // District is OR within the column; Requested By narrows (AND): the example from the brief.
    const combo = await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id, districtIds: [balod.id, durg.id], requesterIds: [twinA.id] });
    same(ids(combo), [r1.id, r2.id].sort(), "State AND (District1 OR District2) AND Requester");
    same(ids(await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id, districtIds: [balod.id, rajgarh.id] })), [r1.id, r3.id, r4.id].sort(), "two districts → either");
    same(ids(await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id, requesterIds: [twinA.id, twinB.id] })), [r1.id, r2.id, r3.id].sort(), "two requesters → either");
    // Invalid / out-of-scope ids are dropped, never trusted: switching State prunes selections that no longer apply.
    const stale = await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: other.id, districtIds: [balod.id, foreign.id], requesterIds: [twinA.id, lone.id, "bogus"] });
    same(stale.applied, { stateId: other.id, districtIds: [foreign.id], requesterIds: [lone.id] }, "selections from another State are removed; valid ones are kept");
    same(ids(stale), [r5.id]);
    assert.equal((await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: "nope" })).applied.stateId, "", "an unknown State is ignored (All States)");
    same(ids(await svc.listMarketRequestsFiltered(ADMIN, "review", { districtIds: ["x'; DROP TABLE", "y"] })), all, "garbage ids filter nothing and break nothing");
    same(ids(await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id, districtIds: [foreign.id] })), [r1.id, r2.id, r3.id, r4.id].sort(), "a district of another State is not a valid choice under this State");

    // Two requesters of ONE territory stay two options; several territories are listed once each; the requester's own territory is what is shown (not the district's).
    const twinC = await mk("twinC", Role.SALES_OFFICER, st.id);
    await prisma.user.update({ where: { id: twinC.id }, data: { name: "Anil", territory: "raigarh, Korba ,Raigarh" } });
    const r7 = await mkReq(twinC.id, "M7", balod.id);
    const shared = await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id });
    same(shared.requesters.filter((x) => (x.territory ?? "").includes("aigarh")).map((x) => [x.territory, x.name]), [["raigarh, Korba", "Anil"], ["Raigarh", "Chittranjan"]].sort((a, b) => a[0]!.localeCompare(b[0]!)), "distinct territories are joined once each; same-territory requesters are separate options");
    same(shared.items.find((r) => r.id === r7.id)!.requesterTerritory, "raigarh, Korba", "the row carries the requester's territory");
    same(shared.items.find((r) => r.id === r4.id)!.requesterTerritory, null, "no territory → null (the UI shows the fallback)");
    same(ids(await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id, requesterIds: [twinA.id] })), [r1.id, r2.id].sort(), "selecting one requester filters only that requester's records");
    same(ids(await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id, requesterIds: [twinC.id] })), [r7.id], "…even when another requester shares the territory");
    // The territory is not used for the State filter: it comes from the district.
    await prisma.user.update({ where: { id: twinA.id }, data: { territory: "Somewhere Else" } });
    same(ids(await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id, requesterIds: [twinA.id] })), [r1.id, r2.id].sort());
    await prisma.user.update({ where: { id: twinA.id }, data: { territory: "Raigarh" } });
    await prisma.marketRequest.delete({ where: { id: r7.id } }); await prisma.user.delete({ where: { id: twinC.id } });
    // The tab (view) is part of the scope: nothing outside it is offered or returned.
    await prisma.marketRequest.update({ where: { id: r1.id }, data: { status: "APPROVED" } });
    const hist = await svc.listMarketRequestsFiltered(ADMIN, "history");
    same(ids(hist), [r1.id], "history shows only decided requests");
    same([hist.districts.map((x) => x.name), hist.requesters.map((x) => x.id)], [["Balod"], [twinA.id]], "options follow the tab");
    const review = await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id, districtIds: [balod.id] });
    same(ids(review), [r4.id], "the same District filter on another tab only sees that tab's rows");
    // Authorization first: an SO sees only their own requests and options; an RM only their team's.
    const mine = await svc.listMarketRequestsFiltered(SO, "mine");
    same([ids(mine), mine.requesters.map((x) => x.id), mine.states.map((x) => x.name)], [[r4.id, legacy.id].sort(), [so.id], ["State A"]], "an SO cannot retrieve rows or options of others");
    same(ids(await svc.listMarketRequestsFiltered(SO, "mine", { requesterIds: [twinA.id] })), [r4.id, legacy.id].sort(), "asking for another employee's requests widens nothing (the id is dropped)");
    assert.equal((await svc.listMarketRequestsFiltered(RM, "review")).items.some((r) => r.id === r5.id), false, "an RM never sees another State's request");
    assert.equal(await prisma.marketRequest.count({ where: { id: r5.id } }), 1);
    assert.equal(JSON.stringify(await prisma.marketRequest.findMany({ orderBy: { id: "asc" } })).includes('"status":"APPROVED"'), true);
    // Filtering never writes.
    await prisma.marketRequest.update({ where: { id: r1.id }, data: { status: "PENDING_ADMIN" } });
    assert.equal(await state(), snapshot, "filtering changed no request");
    assert.equal(await prisma.market.count(), 0);
    // Approval after filtering still targets the chosen request.
    const target = (await svc.listMarketRequestsFiltered(ADMIN, "review", { stateId: st.id, districtIds: [durg.id] })).items[0]!;
    await svc.actOnMarketRequest(ADMIN, target.id, { action: "approve" });
    same((await prisma.marketRequest.findMany({ where: { status: "APPROVED" } })).map((r) => r.id), [r2.id], "only the filtered-and-chosen request was approved");
  }
  console.log("market-request.integration.ts — all assertions passed");
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
