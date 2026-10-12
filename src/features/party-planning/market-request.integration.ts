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
  console.log("market-request.integration.ts — all assertions passed");
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
