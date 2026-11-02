/** Reviewed, exact-row sales ownership correction. Dry-run by default; never guesses by updatedAt.
 * Apply requires a workbook-verified manifest plus an exclusive before-image backup path.
 * node --import tsx scripts/repair-sales-owner.ts --manifest <json> [--apply --backup <json>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import assert from "node:assert/strict";

export interface SalesOwnerRepair {
  repairId: string;
  dealerId: string;
  sourceOfficerId: string;
  targetOfficerId: string;
  assignmentId: string;
  assignedAt: string;
  seasonId: string;
  monthId: string;
  uploadRunId: string;
  actorId: string;
  workbookPath: string;
  workbookSha256: string;
  rows: { sourceEntryId: string; targetLineId: string; qty: number; value: string; updatedAt: string }[];
}

export async function repairSalesOwner(db: PrismaClient, m: SalesOwnerRepair, backupPath?: string) {
  assert.ok(m.rows.length > 0 && m.sourceOfficerId !== m.targetOfficerId);
  assert.equal(new Set(m.rows.map((r) => r.sourceEntryId)).size, m.rows.length);
  assert.equal(new Set(m.rows.map((r) => r.targetLineId)).size, m.rows.length);
  assert.equal(createHash("sha256").update(readFileSync(m.workbookPath)).digest("hex"), m.workbookSha256, "Workbook changed after review");
  return db.$transaction(async (tx) => {
    if (!backupPath) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    // Serializes this correction with dealer edits. Exact row versions below reject intervening uploads.
    if (backupPath) await tx.$queryRaw`SELECT "id" FROM "Dealer" WHERE "id" = ${m.dealerId} FOR UPDATE`;
    const previous = await tx.auditLog.findFirst({ where: { entity: "salesOwnershipRepair", entityId: m.repairId } });
    if (previous) return { alreadyApplied: true, rows: 0, amount: "0" };
    const [assignment, run, month, actor, lines, before] = await Promise.all([
      tx.dealerAssignment.findMany({ where: { dealerId: m.dealerId, effectiveTo: null } }),
      tx.salesUploadRun.findUniqueOrThrow({ where: { id: m.uploadRunId } }),
      tx.seasonMonth.findUniqueOrThrow({ where: { id: m.monthId } }),
      tx.user.findUniqueOrThrow({ where: { id: m.actorId }, select: { role: true, isActive: true } }),
      tx.planLine.findMany({ where: { id: { in: m.rows.map((r) => r.targetLineId) } }, include: { planDealer: { include: { seasonPlan: true } } } }),
      // Back up ALL entries of this dealer, including prior months and all manual planning fields.
      tx.monthlyEntry.findMany({ where: { planLine: { planDealer: { dealerId: m.dealerId } } }, orderBy: { id: "asc" }, include: { planLine: { include: { planDealer: { include: { seasonPlan: true } } } } } }),
    ]);
    assert.equal(assignment.length, 1, "Ambiguous assignment; no repair applied");
    assert.equal(assignment[0].id, m.assignmentId);
    assert.equal(assignment[0].officerId, m.targetOfficerId);
    assert.equal(assignment[0].effectiveFrom.toISOString(), m.assignedAt);
    assert.equal(actor.role, "SUPER_ADMIN");
    assert.equal(actor.isActive, true);
    assert.equal(month.seasonId, m.seasonId);
    assert.equal(run.status, "COMPLETED");
    assert.equal(run.seasonMonthId, m.monthId);
    assert.ok(run.createdAt > new Date(m.assignedAt), "Upload predates reassignment");
    let amount = new Prisma.Decimal(0);
    const moves = m.rows.map((r) => {
      const source = before.find((e) => e.id === r.sourceEntryId);
      const line = lines.find((l) => l.id === r.targetLineId);
      assert.ok(source && line, "Missing source or destination");
      const fromPlan = source.planLine.planDealer.seasonPlan;
      const toPlan = line.planDealer.seasonPlan;
      assert.equal(source.planLine.planDealer.dealerId, m.dealerId);
      assert.equal(line.planDealer.dealerId, m.dealerId);
      assert.equal(fromPlan.officerId, m.sourceOfficerId);
      assert.equal(toPlan.officerId, m.targetOfficerId);
      assert.equal(fromPlan.seasonId, m.seasonId);
      assert.equal(toPlan.seasonId, m.seasonId);
      assert.equal(toPlan.status, "APPROVED");
      assert.equal(toPlan.isActiveVersion, true);
      assert.equal(toPlan.lifecycleState, "ACTIVE");
      assert.equal(line.productId, source.planLine.productId);
      assert.equal(source.seasonMonthId, m.monthId);
      assert.equal(source.saleQty, r.qty);
      assert.ok(source.saleValue?.equals(r.value), "Source amount changed");
      assert.equal(source.updatedAt.toISOString(), r.updatedAt, "Source changed since review");
      assert.ok(source.updatedAt > new Date(m.assignedAt) && source.updatedAt <= run.createdAt, "Source is outside reviewed post-transfer upload");
      const target = before.find((e) => e.planLineId === line.id && e.seasonMonthId === m.monthId);
      assert.ok(!target || (target.saleQty === 0 && (!target.saleValue || target.saleValue.isZero())), "Destination already has sales; manual conflict review required");
      amount = amount.plus(r.value);
      return { r, source, target, line };
    });
    if (!backupPath) return { alreadyApplied: false, dryRun: true, rows: moves.length, amount: amount.toFixed(4) };

    writeFileSync(backupPath, JSON.stringify({ manifest: m, run, before, destinationLines: lines }, null, 2), { flag: "wx", mode: 0o600 });
    for (const { r, source, target, line } of moves) {
      // Actuals only. Never move/delete MonthlyEntry rows or change their planQty/planValue/inputMode.
      const data = { saleQty: r.qty, saleValue: new Prisma.Decimal(r.value) };
      if (target) await tx.monthlyEntry.update({ where: { id: target.id }, data });
      else await tx.monthlyEntry.create({ data: { planLineId: line.id, seasonMonthId: m.monthId, ...data } });
      await tx.monthlyEntry.update({ where: { id: source.id }, data: { saleQty: 0, saleValue: 0 } });
    }
    const after = await tx.monthlyEntry.findMany({ where: { planLine: { planDealer: { dealerId: m.dealerId } } }, orderBy: { id: "asc" } });
    const movedIds = new Set(moves.flatMap((x) => [x.source.id, ...(x.target ? [x.target.id] : [])]));
    for (const old of before) {
      const now = after.find((e) => e.id === old.id)!;
      assert.ok(now, "Existing row was deleted");
      const { planLine: _line, ...oldFields } = old;
      void _line;
      if (!movedIds.has(old.id)) assert.deepEqual(now, oldFields, "Unrelated historical entry changed");
      else for (const key of ["planQty", "planValue", "inputMode", "createdAt", "planLineId", "seasonMonthId"] as const) {
        assert.equal(String(now[key]), String(old[key]), `Manual planning field ${key} changed`);
      }
    }
    const totals = (entries: { saleQty: number; saleValue: Prisma.Decimal | null }[]) => ({ qty: entries.reduce((n, e) => n + e.saleQty, 0), value: entries.reduce((n, e) => n.plus(e.saleValue ?? 0), new Prisma.Decimal(0)).toString() });
    assert.deepEqual(totals(after), totals(before), "Dealer sales totals changed");
    await tx.auditLog.create({ data: {
      userId: m.actorId, action: "UPDATE", entity: "salesOwnershipRepair", entityId: m.repairId,
      summary: JSON.stringify({ dealerId: m.dealerId, sourceOfficerId: m.sourceOfficerId, targetOfficerId: m.targetOfficerId, assignedAt: m.assignedAt, uploadRunId: run.id, workbookSha256: m.workbookSha256, monthId: m.monthId, amount: amount.toString(), moves: moves.map(({ r, target }) => ({ ...r, previousTargetEntryId: target?.id ?? null })), rule: "Upload time after reassignment, not invoice date. Existing planning and earlier-month sales preserved." }),
    } });
    return { alreadyApplied: false, dryRun: false, rows: moves.length, amount: amount.toFixed(4) };
  }, { isolationLevel: "Serializable", timeout: 60000, maxWait: 10000 });
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes("--manifest"), "Pass --manifest <reviewed-json>");
  const apply = args.includes("--apply");
  assert.ok(!apply || args.includes("--backup"), "Apply requires --backup <new-file>");
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  assert.ok(url, "Database configuration missing");
  const db = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try { console.log(JSON.stringify(await repairSalesOwner(db, JSON.parse(readFileSync(value("--manifest"), "utf8")), apply ? value("--backup") : undefined))); }
  finally { await db.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof assert.AssertionError ? e.message : "Repair failed; no successful result. Inspect database connectivity and the reviewed manifest."); process.exitCode = 1; });
}
