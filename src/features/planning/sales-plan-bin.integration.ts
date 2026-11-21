/** Real PostgreSQL regression: only a LOCAL database named plan_tx_test is accepted.
 * Uses isolated fixture IDs and removes only those fixtures; never reads a deployment database.
 * PLAN_TX_TEST_URL=postgresql://rahmani@localhost:5432/plan_tx_test node --import tsx src/features/planning/sales-plan-bin.integration.ts
 */
import assert from "node:assert/strict";
import { PrismaClient, Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";

const url = process.env.PLAN_TX_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/plan_tx_test") throw new Error("Set PLAN_TX_TEST_URL to a local plan_tx_test database only.");
const db = new PrismaClient({ datasources: { db: { url } } });
const prefix = `bin-${Date.now()}`;
const admin: AuthContext = { userId: `${prefix}-admin`, username: prefix, role: Role.SUPER_ADMIN, groupId: null };
const rm: AuthContext = { userId: `${prefix}-rm`, username: prefix, role: Role.REGIONAL_MANAGER, groupId: `${prefix}-group` };
const so: AuthContext = { userId: `${prefix}-so`, username: prefix, role: Role.SALES_OFFICER, groupId: rm.groupId };
const load = testLoader({ "@/lib/prisma": { prisma: db }, "@/lib/http": { ApiError: TestApiError } });
const lifecycle = load<typeof import("./lifecycle.server")>("src/features/planning/lifecycle.server.ts");
const bin = load<typeof import("./sales-plan-bin.server")>("src/features/planning/sales-plan-bin.server.ts");
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
async function main() {
let seasonId = "";
let productId = "";
let dealerId = "";
try {
  await db.userGroup.create({ data: { id: rm.groupId!, name: prefix } });
  await db.user.createMany({ data: [admin, rm, so].map((u, i) => ({ id: u.userId, username: `${prefix}-${i}`, name: i === 0 ? "Administrator" : i === 1 ? "Manager" : "Manoj fixture", role: u.role, passwordHash: "fixture", groupId: u.groupId })) });
  const season = await db.season.create({ data: { name: prefix, year: 2026, status: "OPEN" } }); seasonId = season.id;
  const month = await db.seasonMonth.create({ data: { seasonId, name: "August", order: 1, status: "OPEN" } });
  const versions = await Promise.all([1, 2, 3].map(version => db.seasonPlan.create({ data: { seasonId, officerId: so.userId, version, status: "APPROVED", isActiveVersion: version === 3, lifecycleState: version === 3 ? "ACTIVE" : "DEACTIVATED", deactivatedAt: version === 3 ? null : new Date() } })));
  const months = await Promise.all(versions.map(p => db.monthlyPlan.create({ data: { seasonPlanId: p.id, seasonMonthId: month.id, officerId: so.userId, lifecycleState: p.lifecycleState, deactivatedAt: p.deactivatedAt, lifecycleFromParent: p.version !== 3, status: p.version === 1 ? "RETURNED" : "APPROVED" } })));
  const product = await db.product.create({ data: { name: prefix, rate: 100, nbvPercent: 0.1 } }); productId = product.id;
  const dealer = await db.dealer.create({ data: { name: prefix } }); dealerId = dealer.id;
  for (const p of versions) {
    const pd = await db.planDealer.create({ data: { seasonPlanId: p.id, dealerId } });
    const line = await db.planLine.create({ data: { planDealerId: pd.id, productId, inputMode: "TOTAL_QTY", inputValue: p.version * 100 } });
    await db.monthlyEntry.create({ data: { planLineId: line.id, seasonMonthId: month.id, planQty: p.version * 20, saleQty: p.version * 7, planValue: p.version * 1234, saleValue: -p.version * 80 } });
  }
  await db.auditLog.create({ data: { userId: admin.userId, entity: "seasonPlan", entityId: versions[0].id, action: "REPLACE", summary: "Archived for a fresh re-import", createdAt: versions[0].deactivatedAt! } });
  await db.auditLog.create({ data: { userId: admin.userId, entity: "seasonPlan", entityId: versions[1].id, action: "DEACTIVATE", summary: "Seasonal plan deactivated", createdAt: versions[1].deactivatedAt! } });
  const savedValues = () => db.monthlyEntry.findMany({ where: { planLine: { planDealer: { seasonPlan: { seasonId } } } }, orderBy: { id: "asc" } });
  const valuesBefore = JSON.stringify(await savedValues());
  let rows = (await bin.listSalesPlanBin(admin)).filter(p => p.seasonName.startsWith(prefix));
  assert.equal(rows.length, 4, "every archived approval status is included, with parents and months distinct");
  const inherited = rows.find(p => p.id === months[0].id)!;
  assert(inherited.inherited && inherited.reason.includes("replacement") && inherited.actor === "Administrator");
  assert.equal(rows.find(p => p.id === months[1].id)?.reason, "Deactivated with seasonal plan v2. Deactivated by an administrator.");
  assert.equal((await bin.listSalesPlanBin(rm)).filter(p => p.seasonName.startsWith(prefix)).length, 4);
  assert.equal((await bin.listSalesPlanBin({ ...rm, groupId: null })).filter(p => p.seasonName.startsWith(prefix)).length, 0, "an RM cannot see another team's archives");
  assert.equal(await code(bin.listSalesPlanBin(so)), 403);
  assert.equal(await code(lifecycle.getSalesBinRestoreContext(rm, "MONTHLY", months[0].id)), 403);
  assert.equal(await code(lifecycle.restoreSalesBinPlan({ ...admin, role: Role.CUSTOM_ADMIN, permissions: {} }, "MONTHLY", months[0].id, "HISTORICAL", [])), 403);
  const context = await lifecycle.getSalesBinRestoreContext(admin, "MONTHLY", months[0].id);
  assert(context.needsParent && context.activeVersions[0].id === versions[2].id);
  assert.equal(await code(lifecycle.restoreSalesBinPlan(admin, "MONTHLY", months[0].id, "RESTORE", [versions[2].id])), 409, "an active replacement requires an explicit choice");
  assert.equal(await code(lifecycle.restoreSalesBinPlan(admin, "MONTHLY", months[0].id, "REPLACE_ACTIVE", [])), 409, "a stale recovery dialog cannot replace a newly active version");
  await lifecycle.restoreSalesBinPlan(admin, "MONTHLY", months[0].id, "HISTORICAL", []);
  assert.equal((await db.monthlyPlan.findUniqueOrThrow({ where: { id: months[0].id } })).lifecycleState, "CLOSED");
  assert.equal((await db.seasonPlan.findUniqueOrThrow({ where: { id: versions[2].id } })).lifecycleState, "ACTIVE");
  assert.equal((await db.seasonPlan.findUniqueOrThrow({ where: { id: versions[0].id } })).lifecycleState, "DEACTIVATED");
  // Separately closed children must survive a full parent restore.
  await lifecycle.restoreSalesBinPlan(admin, "SEASONAL", versions[0].id, "REPLACE_ACTIVE", [versions[2].id]);
  assert.equal((await db.monthlyPlan.findUniqueOrThrow({ where: { id: months[0].id } })).lifecycleState, "CLOSED");
  assert.equal((await db.monthlyPlan.findUniqueOrThrow({ where: { id: months[2].id } })).lifecycleState, "DEACTIVATED");
  assert.deepEqual((await db.seasonPlan.findMany({ where: { seasonId, lifecycleState: "ACTIVE" }, select: { id: true } })).map(p => p.id), [versions[0].id]);
  assert.deepEqual((await db.seasonPlan.findMany({ where: { seasonId, isActiveVersion: true }, select: { id: true } })).map(p => p.id), [versions[0].id]);
  // Simultaneous restores cannot both become active. One succeeds, the other gets a reviewable conflict.
  const outcomes = await Promise.all([1, 2].map(i => code(lifecycle.restoreSalesBinPlan(admin, "SEASONAL", versions[i].id, "REPLACE_ACTIVE", [versions[0].id]))));
  assert.equal(outcomes.filter(c => c === 0).length, 1);
  assert.equal(outcomes.filter(c => c === 409).length, 1);
  assert.equal(await db.seasonPlan.count({ where: { seasonId, lifecycleState: "ACTIVE" } }), 1);
  assert.equal(await db.seasonPlan.count({ where: { seasonId, isActiveVersion: true } }), 1);
  const liveMonth = await db.monthlyPlan.findFirstOrThrow({ where: { seasonPlan: { seasonId, lifecycleState: "ACTIVE" } } });
  await lifecycle.setMonthlyPlanLifecycle(admin, liveMonth.id, "deactivate");
  const directContext = await lifecycle.getSalesBinRestoreContext(admin, "MONTHLY", liveMonth.id);
  assert(!directContext.needsParent && directContext.activeVersions.length === 0);
  const directRow = (await bin.listSalesPlanBin(admin)).find(p => p.id === liveMonth.id)!;
  assert(!directRow.inherited && directRow.actor === "Administrator" && directRow.reason.includes("administrator"));
  await lifecycle.restoreSalesBinPlan(admin, "MONTHLY", liveMonth.id, "RESTORE", []);
  assert.equal((await db.monthlyPlan.findUniqueOrThrow({ where: { id: liveMonth.id } })).lifecycleState, "ACTIVE");
  assert.equal(await code(lifecycle.restoreSalesBinPlan(admin, "MONTHLY", liveMonth.id, "RESTORE", [])), 409, "a repeated recovery does not change an already recovered plan");
  const archived = await db.seasonPlan.findFirstOrThrow({ where: { seasonId, lifecycleState: "DEACTIVATED" } });
  const active = await db.seasonPlan.findFirstOrThrow({ where: { seasonId, lifecycleState: "ACTIVE" } });
  const failLoad = testLoader({ "@/lib/prisma": { prisma: db }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => { throw new Error("simulated audit failure"); } } });
  const failLifecycle = failLoad<typeof import("./lifecycle.server")>("src/features/planning/lifecycle.server.ts");
  const stateBefore = JSON.stringify(await db.seasonPlan.findMany({ where: { seasonId }, orderBy: { id: "asc" } }));
  await assert.rejects(failLifecycle.restoreSalesBinPlan(admin, "SEASONAL", archived.id, "REPLACE_ACTIVE", [active.id]), /simulated audit failure/);
  assert.equal(JSON.stringify(await db.seasonPlan.findMany({ where: { seasonId }, orderBy: { id: "asc" } })), stateBefore, "an interrupted restore rolls back the entire version switch");
  assert.equal(JSON.stringify(await savedValues()), valuesBefore, "planned quantities, sales, amounts and negative adjustments remain byte-for-byte unchanged");
  await db.seasonMonth.update({ where: { id: month.id }, data: { status: "CLOSED" } });
  rows = (await bin.listSalesPlanBin(admin)).filter(p => p.seasonName.startsWith(prefix));
  assert(rows.every(p => p.kind !== "MONTHLY"), "closed months follow the existing master-period visibility policy");
  await db.season.update({ where: { id: seasonId }, data: { status: "CLOSED" } });
  assert.equal((await bin.listSalesPlanBin(admin)).filter(p => p.seasonName.startsWith(prefix)).length, 0);
  assert.equal(await code(lifecycle.getSalesBinRestoreContext(admin, "SEASONAL", archived.id)), 404);
  console.log("sales-plan-bin.integration.ts — scope, reasons, historical/full restore, version conflicts, atomic rollback and saved-value preservation passed");
} finally {
  if (seasonId) {
    await db.seasonPlan.deleteMany({ where: { seasonId } });
    await db.seasonMonth.deleteMany({ where: { seasonId } });
    await db.season.deleteMany({ where: { id: seasonId } });
  }
  if (productId) await db.product.deleteMany({ where: { id: productId } });
  if (dealerId) await db.dealer.deleteMany({ where: { id: dealerId } });
  await db.auditLog.deleteMany({ where: { userId: admin.userId } });
  await db.user.deleteMany({ where: { id: { in: [admin.userId, rm.userId, so.userId] } } });
  await db.userGroup.deleteMany({ where: { id: rm.groupId! } });
  await db.$disconnect();
}

}
main().catch(err => { console.error(err); process.exitCode = 1; });
