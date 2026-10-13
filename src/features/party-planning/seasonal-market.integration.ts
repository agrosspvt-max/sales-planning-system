/**
 * Seasonal Planning → territory Market names, against a REAL, disposable PostgreSQL database (row locks, unique indexes and rollback are what
 * the concurrency guarantees rest on — an in-memory fake cannot prove them).
 *
 *   createdb seasonal_market_test && DATABASE_URL=postgresql://localhost:5432/seasonal_market_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   SEASONAL_MARKET_TEST_URL=postgresql://localhost:5432/seasonal_market_test npm run test:seasonal-markets:db
 *
 * Only a LOCAL database named `seasonal_market_test` is permitted — the script TRUNCATEs the tables it uses.
 */
import assert from "node:assert/strict";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

const url = process.env.SEASONAL_MARKET_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/seasonal_market_test")
  throw new Error("Only a local database named seasonal_market_test is permitted (set SEASONAL_MARKET_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
let failAudit = false;
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => { if (failAudit && data.entity === "seasonalPlan") throw new Error("injected audit failure"); return tx.auditLog.create({ data }); } },
});
const svc = load("src/features/party-planning/seasonal.server.ts") as typeof import("./seasonal.server");
const ctx = (userId: string, role: Role, groupId: string | null) => ({ userId, role, username: userId, groupId, designation: null }) as unknown as AuthContext;
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "SeasonalPlan","SeasonalPlanSheet","DealerMarketMapping","DealerAssignment","Dealer","Market","MarketRequest","AuditLog","Season","User","UserGroup" CASCADE`);
  const g = await prisma.userGroup.create({ data: { name: "State A" } });
  const mk = (u: string, role: Role) => prisma.user.create({ data: { passwordHash: "x", name: u, username: u, role, groupId: g.id } });
  const so1 = await mk("so1", Role.SALES_OFFICER), so2 = await mk("so2", Role.SALES_OFFICER);
  const season = await prisma.season.create({ data: { name: "Kharif", year: 2026, status: "OPEN" } });
  const old = await prisma.market.create({ data: { name: "Old Underlying", nameKey: "old underlying" } });
  const dealer = async (name: string, owner: string, marketText: string | null) => {
    const d = await prisma.dealer.create({ data: { name } });
    await prisma.dealerAssignment.create({ data: { dealerId: d.id, officerId: owner, effectiveFrom: new Date("2026-01-01") } });
    return prisma.dealerMarketMapping.create({ data: { dealerId: d.id, marketId: old.id, marketText } });
  };
  const karuamor = await dealer("test_dealer4", so1.id, "Karuamor"); // edited name, NO Market record
  const A = ctx(so1.id, Role.SALES_OFFICER, g.id), B = ctx(so2.id, Role.SALES_OFFICER, g.id);
  const sheetA = await svc.createSeasonalSheet(A, { seasonId: season.id }), sheetB = await svc.createSeasonalSheet(B, { seasonId: season.id });
  const countAll = async () => ({ markets: await prisma.market.count(), plans: await prisma.seasonalPlan.count(), audit: await prisma.auditLog.count() });

  const before = await countAll();
  const opts = await svc.listSeasonalMarketOptions(A, sheetA.id);
  const kar = opts.markets.find((m) => m.name === "Karuamor")!;
  assert.ok(kar && kar.id === null && kar.territoryMappingId === karuamor.id, "Karuamor is offered, by reference to the owner's mapping");
  assert.deepEqual(await countAll(), before, "listing the choices wrote nothing");

  assert.equal(await code(svc.createSeasonalPlan(B, { sheetId: sheetB.id, territoryMappingId: karuamor.id, expectedMarket: "Karuamor" })), 422, "another SO cannot use the mapping");
  assert.equal(await code(svc.createSeasonalPlan(A, { sheetId: sheetA.id, territoryMappingId: karuamor.id, expectedMarket: "Other Name" })), 409, "the saved name is verified");
  assert.deepEqual(await countAll(), before, "refused saves wrote nothing");

  // parallel identical saves (and the same Market name racing from two different owners' plans)
  const mapB = await dealer("b_dealer", so2.id, "karuamor"); // so2's own mapping with the same normalized name
  const res = await Promise.all([
    ...[1, 2, 3, 4].map(() => code(svc.createSeasonalPlan(A, { sheetId: sheetA.id, territoryMappingId: karuamor.id, expectedMarket: "Karuamor" }))),
    code(svc.createSeasonalPlan(B, { sheetId: sheetB.id, territoryMappingId: mapB.id, expectedMarket: "karuamor" })),
  ]);
  assert.equal(res.slice(0, 4).filter((r) => r === 0).length, 1, `one of four identical saves wins: ${res.join()}`);
  assert.ok(res.slice(0, 4).filter((r) => r !== 0).every((r) => r === 409), "the rest are clean 409s");
  assert.equal(res[4], 0, "the other owner's save succeeds");
  assert.equal(await prisma.market.count({ where: { nameKey: "karuamor" } }), 1, "ONE canonical Market for both owners");
  assert.equal(await prisma.seasonalPlan.count({ where: { sheetId: sheetA.id } }), 1, "ONE plan row in so1's sheet");
  const m = (await prisma.market.findFirst({ where: { nameKey: "karuamor" } }))!;
  assert.deepEqual([m.name, m.source, m.potential, m.createdById !== null], ["Karuamor", "EXISTING", null, true]);
  assert.equal(await prisma.auditLog.count({ where: { entity: "market", entityId: m.id } }), 1, "the Market creation is audited once");
  assert.equal((await svc.getSeasonalSheet(A, sheetA.id)).plans[0]!.marketName, "Karuamor", "reload shows the saved name");
  assert.equal((await prisma.dealerMarketMapping.findUnique({ where: { id: karuamor.id } }))!.marketText, "Karuamor", "the mapping is untouched");
  assert.equal((await prisma.market.findUnique({ where: { id: old.id } }))!.name, "Old Underlying", "the old underlying Market is not renamed");

  // many rounds of identical parallel saves: never two plan rows for one Market in one sheet (the sheet row lock serializes them)
  for (let round = 1; round <= 6; round++) {
    const name = `Round ${round} Mandi`, map = await dealer(`r${round}_dealer`, so1.id, name);
    if (round % 2 === 0) await prisma.market.create({ data: { name, nameKey: name.toLowerCase() } }); // Market already exists: only the sheet lock stops duplicate plan rows (no unique index covers them)
    const r = await Promise.all(Array.from({ length: 8 }, () => code(svc.createSeasonalPlan(A, { sheetId: sheetA.id, territoryMappingId: map.id, expectedMarket: name }))));
    assert.equal(r.filter((x) => x === 0).length, 1, `round ${round}: exactly one save wins (${r.join()})`);
    assert.equal(await prisma.seasonalPlan.count({ where: { sheetId: sheetA.id, market: { name } } }), 1, `round ${round}: one plan row`);
    assert.equal(await prisma.market.count({ where: { name } }), 1, `round ${round}: one Market`);
  }

  // atomicity: a failing audit write after the Market insert leaves neither a Market nor a plan
  const lone = await dealer("c_dealer", so1.id, "Atomic Mandi");
  const snap = await countAll();
  failAudit = true; // fails AFTER the Market was inserted and the plan row created
  const failed = await code(svc.createSeasonalPlan(A, { sheetId: sheetA.id, territoryMappingId: lone.id, expectedMarket: "Atomic Mandi" }));
  failAudit = false;
  assert.notEqual(failed, 0);
  assert.deepEqual(await countAll(), snap, "Market, plan and audit are one transaction: nothing was left behind");
  console.log("seasonal-market.integration.ts — all assertions passed");
}
main().then(() => prisma.$disconnect(), async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
