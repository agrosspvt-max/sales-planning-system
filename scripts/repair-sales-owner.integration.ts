import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { repairSalesOwner, type SalesOwnerRepair } from "./repair-sales-owner";

const url = process.env.SALES_OWNER_TEST_URL;
assert.ok(url && new URL(url).hostname === "localhost" && new URL(url).pathname === "/repair_sales_owner_test" && new URL(url).searchParams.get("host")?.startsWith("/tmp/sales-owner-pg."), "Only a disposable local sales-owner database is allowed");
const db = new PrismaClient({ datasources: { db: { url } } });
const temp = mkdtempSync(join(tmpdir(), "sales-owner-fixture."));
const workbookPath = join(temp, "workbook.xlsx");
writeFileSync(workbookPath, "reviewed workbook fixture");
const changed = new Date("2026-11-02T06:46:01.036Z");
const m: SalesOwnerRepair = {
  repairId: "repair", dealerId: "dealer", sourceOfficerId: "old", targetOfficerId: "new", assignmentId: "assignment",
  assignedAt: "2026-10-23T07:57:53.947Z", seasonId: "season", monthId: "oct", uploadRunId: "run", actorId: "admin", workbookPath,
  workbookSha256: createHash("sha256").update(readFileSync(workbookPath)).digest("hex"),
  rows: [{ sourceEntryId: "old-p1", targetLineId: "new-p1", qty: 50, value: "24650", updatedAt: changed.toISOString() }, { sourceEntryId: "old-p2", targetLineId: "new-p2", qty: 0, value: "-111", updatedAt: changed.toISOString() }],
};
const snapshot = async () => JSON.stringify(await db.monthlyEntry.findMany({ orderBy: { id: "asc" } }));
async function seed() {
  await db.$executeRawUnsafe('TRUNCATE "User", "Season", "Dealer", "Product" CASCADE');
  await db.user.createMany({ data: ["old", "new", "admin"].map((id) => ({ id, name: id, username: id, role: id === "admin" ? "SUPER_ADMIN" : "SALES_OFFICER", passwordHash: "fixture" })) });
  await db.season.create({ data: { id: "season", name: "Kharif", year: 2026, startMonth: 4, startYear: 2026, endMonth: 10, endYear: 2026 } });
  await db.seasonMonth.createMany({ data: [{ id: "sep", seasonId: "season", name: "September", order: 1, calendarMonth: 9, calendarYear: 2026 }, { id: "oct", seasonId: "season", name: "October", order: 2, calendarMonth: 10, calendarYear: 2026 }] });
  await db.dealer.create({ data: { id: "dealer", name: "Siddhi" } });
  await db.dealerAssignment.create({ data: { id: "assignment", dealerId: "dealer", officerId: "new", effectiveFrom: new Date(m.assignedAt) } });
  await db.product.createMany({ data: ["p1", "p2"].map((id) => ({ id, name: id, rate: 100, nbvPercent: 0.4 })) });
  for (const officerId of ["old", "new"]) {
    await db.seasonPlan.create({ data: { id: officerId, officerId, seasonId: "season", status: "APPROVED", isActiveVersion: true } });
    await db.planDealer.create({ data: { id: officerId, seasonPlanId: officerId, dealerId: "dealer" } });
    await db.planLine.createMany({ data: ["p1", "p2"].map((productId) => ({ id: `${officerId}-${productId}`, productId, planDealerId: officerId })) });
  }
  await db.monthlyEntry.createMany({ data: [
    { id: "old-p1", planLineId: "old-p1", seasonMonthId: "oct", saleQty: 50, saleValue: 24650, planQty: 17, planValue: 1200, inputMode: "VALUE", updatedAt: changed },
    { id: "old-p2", planLineId: "old-p2", seasonMonthId: "oct", saleQty: 0, saleValue: -111, updatedAt: changed },
    { id: "prior", planLineId: "old-p1", seasonMonthId: "sep", saleQty: 90, saleValue: 45520, updatedAt: new Date("2026-10-10") },
    { id: "target", planLineId: "new-p1", seasonMonthId: "oct", planQty: 34, planValue: 4500, inputMode: "QTY" },
  ] });
  await db.salesUploadRun.create({ data: { id: "run", uploadedById: "admin", workbookName: "workbook.xlsx", seasonMonthId: "oct", targetMonthName: "October", status: "COMPLETED", createdAt: new Date("2026-11-02T06:46:07.530Z") } });
}

async function main() {
  const push = spawnSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", resolve("prisma/schema.prisma"), "--skip-generate"], { cwd: temp, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: "utf8" });
  assert.equal(push.status, 0, push.stdout + push.stderr);
  await seed();
  const before = await snapshot();
  const preview = await repairSalesOwner(db, m);
  assert.equal(preview.rows, 2); assert.equal(preview.amount, "24539.0000");
  assert.equal(await snapshot(), before, "dry run changes nothing");

  await db.monthlyEntry.update({ where: { id: "target" }, data: { saleQty: 1 } });
  const conflict = await snapshot();
  await assert.rejects(repairSalesOwner(db, m, join(temp, "conflict.json")), /Destination already has sales/);
  assert.equal(await snapshot(), conflict, "destination conflict is atomic");
  await seed();
  await assert.rejects(repairSalesOwner(db, { ...m, rows: [{ ...m.rows[0], value: "999" }] }, join(temp, "stale.json")), /Source amount changed/);
  await assert.rejects(repairSalesOwner(db, { ...m, assignedAt: "2026-12-01T00:00:00.000Z" }, join(temp, "date.json")));

  // Force failure AFTER row changes to prove the entire correction rolls back.
  await db.$executeRawUnsafe('CREATE FUNCTION reject_repair_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'fixture audit failure\'; END $$');
  await db.$executeRawUnsafe('CREATE TRIGGER reject_repair_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION reject_repair_audit()');
  const rollback = await snapshot();
  await assert.rejects(repairSalesOwner(db, m, join(temp, "rollback.json")));
  assert.equal(await snapshot(), rollback, "audit failure rolls all actual changes back");
  await db.$executeRawUnsafe('DROP TRIGGER reject_repair_audit ON "AuditLog"');
  await db.$executeRawUnsafe('DROP FUNCTION reject_repair_audit()');

  const oldPrior = await db.monthlyEntry.findUniqueOrThrow({ where: { id: "prior" } });
  const applied = await repairSalesOwner(db, m, join(temp, "backup.json"));
  assert.equal(applied.rows, 2);
  assert.equal(JSON.parse(readFileSync(join(temp, "backup.json"), "utf8")).before.length, 4);
  assert.deepEqual(await db.monthlyEntry.findUniqueOrThrow({ where: { id: "prior" } }), oldPrior);
  const source = await db.monthlyEntry.findUniqueOrThrow({ where: { id: "old-p1" } });
  assert.equal(source.saleQty, 0); assert.equal(source.saleValue?.toString(), "0");
  assert.equal(source.planQty, 17); assert.equal(source.planValue?.toString(), "1200"); assert.equal(source.inputMode, "VALUE");
  const target = await db.monthlyEntry.findUniqueOrThrow({ where: { id: "target" } });
  assert.equal(target.saleQty, 50); assert.equal(target.planQty, 34); assert.equal(target.planValue?.toString(), "4500");
  const negative = await db.monthlyEntry.findUniqueOrThrow({ where: { planLineId_seasonMonthId: { planLineId: "new-p2", seasonMonthId: "oct" } } });
  assert.equal(negative.saleValue?.toString(), "-111");
  assert.equal((await repairSalesOwner(db, m, join(temp, "repeat.json"))).alreadyApplied, true);
  assert.equal(await db.auditLog.count({ where: { entity: "salesOwnershipRepair" } }), 1);
  console.log("Sales ownership repair DB tests passed: dry run, exact values, conflicts, cutoff, audit-failure rollback, backup, manual planning, earlier sales, negative amounts and idempotency.");
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await db.$disconnect(); rmSync(temp, { recursive: true, force: true }); });
