/**
 * Phase 8 — Scheme Upload LIVE DB integration suite (run locally; NOT run in the sandbox).
 *
 * Exercises the REAL `analyzeSchemeUpload` / `commitSchemeUpload` against a live Postgres to verify the four
 * mandatory Phase 7 guarantees that need a database:
 *
 *   7A ISOLATION      — normal Sales Planning actuals (MonthlyEntry sum/count) are byte-for-byte unchanged
 *                       across a Scheme Upload commit.
 *   7B RE-UPLOAD      — re-uploading the exact scheme+range supersedes the old scope (1 SUPERSEDED + 1
 *                       ACTIVE), keeps the old SchemeSale history, and achievement uses only the ACTIVE scope
 *                       (no double counting).
 *   7C MULTI-SCHEME   — one file for two schemes → two independent scopes + independent SchemeSale rows;
 *                       re-uploading only scheme A leaves scheme B's scope untouched.
 *   7D ATOMIC ROLLBACK— a forced failure mid-commit rolls back the batch/scope/sale writes AND the supersede,
 *                       leaving no partial state and no scope wrongly left SUPERSEDED.
 *   +  a payment-allocation Paid/Total smoke check is intentionally out of scope here (no ledger fixtures).
 *
 * SAFETY: it reuses your existing Super Admin, two active dealers and two active products (read-only), and
 * only CREATES clearly-prefixed temp fixtures (schemes named `P8IT_…`, their requirement rows, enrollments)
 * plus the upload batches it commits. Everything it creates is removed in a `finally` block, so a normal run
 * leaves your database exactly as it found it. It never writes MonthlyEntry or any normal Sales Planning row.
 *
 * REQUIREMENTS: a reachable `DATABASE_URL` and a generated Prisma client for your platform (macOS dev).
 *
 * RUN:
 *   npx prisma generate
 *   npx tsx scripts/scheme-upload-integration.ts
 *   # or: npm run test:db
 *
 * It exits non-zero on the first failed assertion. It is deliberately standalone (no test framework).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- Neutralise `server-only` so the service modules (which import it) load under tsx/node. ---
import Module from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const stubPath = join(tmpdir(), "p8-server-only-stub.js");
writeFileSync(stubPath, "module.exports = {};");
const _resolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === "server-only" || request === "client-only") return stubPath;
  return _resolve.call(this, request, ...rest);
};

import * as XLSX from "xlsx";
import { PrismaClient, Role, SchemeRequirementType, SchemeValueMode, SchemeStatus, SchemeEnrollmentStatus, SchemePlanState, SchemePlanStatus, SchemeUploadStatus } from "@prisma/client";

const prisma = new PrismaClient();

// Services are imported dynamically AFTER the server-only shim is installed.
const services = await import("../src/features/schemes/scheme-upload.server");
const achievement = await import("../src/features/schemes/scheme-achievement.server");

let checks = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  checks += 1;
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
}

const PREFIX = "P8IT_";
const createdSchemeIds: string[] = [];
const createdBatchIds: string[] = [];

/** Build an in-memory Tally Sales Register workbook matching the shared parser's expected layout. */
function buildWorkbook(dealers: { name: string; products: { name: string; qty: number; value: number }[] }[]): Buffer {
  const aoa: (string | number | null)[][] = [
    ["Group Name", "Particulars", "Quantity", "Value"], // header row (parser skips)
    [null, null, null, null],
    [null, null, null, null],
  ];
  for (const d of dealers) {
    // Dealer header: Group Name present + no qty in col C → recognised as a dealer, not a product row.
    aoa.push(["TESTGROUP", d.name, null, d.products.reduce((s, p) => s + p.value, 0)]);
    for (const p of d.products) aoa.push([null, p.name, p.qty, p.value]); // product row: empty A, qty in C
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sales Register");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function main() {
  // --- Reuse existing masters (read-only) ---
  const admin = (await prisma.user.findFirst({ where: { role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }, select: { id: true, name: true, groupId: true } }));
  if (!admin) throw new Error("No active SUPER_ADMIN found — cannot run the integration suite.");
  const ctx = { userId: admin.id, role: Role.SUPER_ADMIN, username: admin.name, groupId: admin.groupId };

  const dealers = (await prisma.dealer.findMany({ where: { isActive: true, deletedAt: null }, take: 2, select: { id: true, name: true } }));
  if (dealers.length < 2) throw new Error("Need at least 2 active dealers to run the integration suite.");
  const products = (await prisma.product.findMany({ where: { isActive: true }, take: 2, select: { id: true, name: true } }));
  if (products.length < 2) throw new Error("Need at least 2 active products to run the integration suite.");
  const [dA, dB] = dealers;
  const [pA, pB] = products;

  // --- Create temp schemes (perpetual → any upload range is in-period) ---
  const baseScheme = { isPerpetual: true, startDate: null, endDate: null, bookingLastDate: null, schemeValueWithoutGST: 100000, schemeValueWithGST: 118000, schemeBenefit: "OTHER" as const, benefitDetails: "Integration test", allowMultipleSchemes: false, status: SchemeStatus.OPEN, createdById: admin.id };

  const productScheme = (await prisma.scheme.create({ data: { ...baseScheme, schemeName: `${PREFIX}Product Scheme ${Date.now()}`, requirementType: SchemeRequirementType.PRODUCT_BASED, requirementProducts: { create: [{ productId: pA.id, requiredQty: 1000 }, { productId: pB.id, requiredQty: 1000 }] } }, select: { id: true } }));
  const valueScheme = (await prisma.scheme.create({ data: { ...baseScheme, schemeName: `${PREFIX}Value Combined Scheme ${Date.now()}`, requirementType: SchemeRequirementType.VALUE_BASED, valueMode: SchemeValueMode.COMBINED, combinedRequiredValue: 500000, requirementProducts: { create: [{ productId: pA.id }, { productId: pB.id }] } }, select: { id: true } }));
  createdSchemeIds.push(productScheme.id, valueScheme.id);

  // --- Enroll both dealers into both schemes (admin is used as the plan's salesOfficer; admin scope = all) ---
  for (const schemeId of [productScheme.id, valueScheme.id]) {
    for (const d of [dA, dB]) {
      await prisma.dealerSchemePlan.create({ data: { schemeId, dealerId: d.id, salesOfficerId: admin.id, planningStatus: SchemePlanStatus.RM_APPROVED, planStatus: SchemePlanState.APPROVED, enrollmentStatus: SchemeEnrollmentStatus.ENROLLED, numberOfSchemes: 1 } });
    }
  }

  const range = { startDate: "2026-08-25", endDate: "2026-09-10" };
  const rangeStart = new Date(range.startDate);
  const rangeEnd = new Date(range.endDate);

  // --- 7A ISOLATION ---
  const before = await prisma.monthlyEntry.aggregate({ _sum: { saleQty: true, saleValue: true }, _count: true });
  const wbProduct = buildWorkbook([
    { name: dA.name, products: [{ name: pA.name, qty: 700, value: 70000 }, { name: pB.name, qty: 1100, value: 110000 }] },
    { name: dB.name, products: [{ name: pA.name, qty: 500, value: 50000 }] },
  ]);
  const r1 = await services.commitSchemeUpload(ctx as any, wbProduct, "p8it-product.xlsx", { ...range, schemeIds: [productScheme.id] });
  createdBatchIds.push(r1.batchId);
  const after = await prisma.monthlyEntry.aggregate({ _sum: { saleQty: true, saleValue: true }, _count: true });
  ok(before._count === after._count && String(before._sum.saleQty) === String(after._sum.saleQty) && String(before._sum.saleValue) === String(after._sum.saleValue),
    "7A: MonthlyEntry sum/count unchanged after Scheme Upload commit (isolation)");
  ok(r1.totalContributions === 3, `7A: 3 SchemeSale contributions committed (got ${r1.totalContributions})`);

  // --- 7B RE-UPLOAD (exact same scheme + range) ---
  const r2 = await services.commitSchemeUpload(ctx as any, wbProduct, "p8it-product-2.xlsx", { ...range, schemeIds: [productScheme.id], replace: true });
  createdBatchIds.push(r2.batchId);
  const scopes = await prisma.schemeUploadBatchScheme.findMany({ where: { schemeId: productScheme.id, startDate: rangeStart, endDate: rangeEnd }, select: { id: true, status: true, _count: { select: { sales: true } } } });
  const active = scopes.filter((s) => s.status === SchemeUploadStatus.ACTIVE);
  const superseded = scopes.filter((s) => s.status === SchemeUploadStatus.SUPERSEDED);
  ok(active.length === 1, `7B: exactly 1 ACTIVE scope after re-upload (got ${active.length})`);
  ok(superseded.length === 1, `7B: exactly 1 SUPERSEDED scope after re-upload (got ${superseded.length})`);
  ok(superseded.every((s) => s._count.sales > 0), "7B: superseded scope retains its SchemeSale history");
  const ach = await achievement.computeSchemeAchievement(ctx as any, [productScheme.id]);
  const prodAch = ach.get(productScheme.id)?.product;
  // Achievement uses ACTIVE scope only → pA achieved = 700 + 500 = 1200 (not doubled to 2400).
  ok(!!prodAch && Math.round(prodAch.achievedQty) === 1200 + 1100, `7B: achievement counts ACTIVE scope only, no double count (got ${prodAch?.achievedQty})`);

  // --- 7C MULTI-SCHEME (one file, two schemes) then replace only A ---
  const wbMulti = buildWorkbook([
    { name: dA.name, products: [{ name: pA.name, qty: 200, value: 200000 }, { name: pB.name, qty: 300, value: 150000 }] },
  ]);
  const r3 = await services.commitSchemeUpload(ctx as any, wbMulti, "p8it-multi.xlsx", { startDate: "2026-10-01", endDate: "2026-10-31", schemeIds: [productScheme.id, valueScheme.id], replace: true });
  createdBatchIds.push(r3.batchId);
  ok(r3.schemes.length === 2, `7C: two independent scopes created from one file (got ${r3.schemes.length})`);
  const octStart = new Date("2026-10-01"), octEnd = new Date("2026-10-31");
  const valueScopeBefore = await prisma.schemeUploadBatchScheme.findFirst({ where: { schemeId: valueScheme.id, startDate: octStart, endDate: octEnd, status: SchemeUploadStatus.ACTIVE }, select: { id: true, _count: { select: { sales: true } } } });
  // Re-upload ONLY the product scheme for the same Oct range → value scheme scope must be untouched.
  const r4 = await services.commitSchemeUpload(ctx as any, buildWorkbook([{ name: dA.name, products: [{ name: pA.name, qty: 10, value: 10000 }] }]), "p8it-multi-2.xlsx", { startDate: "2026-10-01", endDate: "2026-10-31", schemeIds: [productScheme.id], replace: true });
  createdBatchIds.push(r4.batchId);
  const valueScopeAfter = await prisma.schemeUploadBatchScheme.findFirst({ where: { id: valueScopeBefore?.id }, select: { id: true, status: true, _count: { select: { sales: true } } } });
  ok(!!valueScopeAfter && valueScopeAfter.status === SchemeUploadStatus.ACTIVE && valueScopeAfter._count.sales === valueScopeBefore?._count.sales,
    "7C: replacing scheme A did not modify scheme B's scope");

  // --- 7D ATOMIC ROLLBACK (force a failure inside the commit transaction) ---
  const activeScopeBeforeD = await prisma.schemeUploadBatchScheme.findFirst({ where: { schemeId: productScheme.id, startDate: rangeStart, endDate: rangeEnd, status: SchemeUploadStatus.ACTIVE }, select: { id: true } });
  const batchCountBefore = await prisma.schemeUploadBatch.count();
  const origTx = prisma.$transaction.bind(prisma);
  (prisma as any).$transaction = async (arg: any, opts: any) => {
    if (typeof arg === "function") return origTx(async (tx: any) => { await arg(tx); throw new Error("FORCED_ROLLBACK_TEST"); }, opts);
    return origTx(arg, opts);
  };
  let threw = false;
  try {
    await services.commitSchemeUpload(ctx as any, wbProduct, "p8it-rollback.xlsx", { ...range, schemeIds: [productScheme.id], replace: true });
  } catch (e) {
    threw = (e as Error).message.includes("FORCED_ROLLBACK_TEST");
  } finally {
    (prisma as any).$transaction = origTx;
  }
  ok(threw, "7D: forced mid-commit failure threw");
  const batchCountAfter = await prisma.schemeUploadBatch.count();
  ok(batchCountAfter === batchCountBefore, "7D: no new SchemeUploadBatch row after rollback");
  const activeScopeAfterD = await prisma.schemeUploadBatchScheme.findFirst({ where: { id: activeScopeBeforeD?.id }, select: { status: true } });
  ok(!!activeScopeAfterD && activeScopeAfterD.status === SchemeUploadStatus.ACTIVE, "7D: prior ACTIVE scope was NOT left SUPERSEDED (supersede rolled back)");
}

async function cleanup() {
  // Remove everything the suite created (children first). Uses the ids we captured; also sweeps by prefix.
  try {
    const scopeIds = (await prisma.schemeUploadBatchScheme.findMany({ where: { batchId: { in: createdBatchIds } }, select: { id: true } })).map((s) => s.id);
    if (scopeIds.length) await prisma.schemeSale.deleteMany({ where: { scopeId: { in: scopeIds } } });
    if (createdBatchIds.length) await prisma.schemeUploadBatchScheme.deleteMany({ where: { batchId: { in: createdBatchIds } } });
    if (createdBatchIds.length) await prisma.schemeUploadBatch.deleteMany({ where: { id: { in: createdBatchIds } } });
    if (createdSchemeIds.length) {
      // Any scopes/sales created for these schemes by re-upload paths whose batch we might have missed.
      const allScopes = (await prisma.schemeUploadBatchScheme.findMany({ where: { schemeId: { in: createdSchemeIds } }, select: { id: true, batchId: true } }));
      const sIds = allScopes.map((s) => s.id);
      if (sIds.length) await prisma.schemeSale.deleteMany({ where: { scopeId: { in: sIds } } });
      if (sIds.length) await prisma.schemeUploadBatchScheme.deleteMany({ where: { id: { in: sIds } } });
      const bIds = [...new Set(allScopes.map((s) => s.batchId))];
      if (bIds.length) await prisma.schemeUploadBatch.deleteMany({ where: { id: { in: bIds } } });
      await prisma.dealerSchemePlan.deleteMany({ where: { schemeId: { in: createdSchemeIds } } });
      await prisma.schemeRequirementProduct.deleteMany({ where: { schemeId: { in: createdSchemeIds } } });
      await prisma.scheme.deleteMany({ where: { id: { in: createdSchemeIds } } });
    }
  } catch (e) {
    console.error("  cleanup warning:", (e as Error).message);
  }
}

main()
  .catch((e) => { failures += 1; console.error("SUITE ERROR:", e); })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${checks - failures}/${checks} checks passed`);
    process.exit(failures > 0 ? 1 : 0);
  });
