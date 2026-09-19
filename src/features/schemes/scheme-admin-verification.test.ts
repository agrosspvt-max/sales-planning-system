/** Service-level contracts for Admin Verification bill-product batching and atomic rollback. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { AuthContext } from "@/lib/http";

const localRequire = createRequire(import.meta.url);
function loadService<T>(name: string, prisma: object, overrides: Record<string, unknown> = {}): T {
  const filename = resolve("src/features/schemes", name);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    "server-only": {}, "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } },
    "@/lib/scope": { getOfficerScope: async () => ({ all: true, ids: [] }) },
    "@/lib/audit": { writeAudit: async (data: Record<string, unknown>, tx: { auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> } }) => tx.auditLog.create({ data }) },
    "./scheme-plan-quantity.server": { conversionQuantityPlanSelect: {}, applyConversionQuantity: async () => ({ split: false }) },
    ...overrides,
  };
  runInNewContext(code, {
    exports, Date, console,
    require: (id: string) => id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id),
  }, { filename });
  return exports as T;
}

type ProductRow = {
  id: string; billId: string; productId: string; soQty: number | null; adminQty: number | null;
  rateWithoutGST: number; rateWithGST: number; createdAt: string;
};
const number = (value: unknown) => value == null ? null : Number((value as { toString(): string }).toString());

async function testBulkSql() {
  const service = loadService<typeof import("./scheme-bill-product.server")>("scheme-bill-product.server.ts", {});
  const rows = new Map<string, ProductRow>();
  rows.set("bill-1:p1", { id: "historical-id", billId: "bill-1", productId: "p1", soQty: 10, adminQty: null, rateWithoutGST: 100, rateWithGST: 118, createdAt: "historical-created-at" });
  let executeCalls = 0;
  let lastSql = "";
  const db = {
    $executeRawUnsafe: async () => { throw new Error("unsafe SQL must not be used by the batch helper"); },
    $executeRaw: async (query: { text: string; values: unknown[] }) => {
      executeCalls++;
      lastSql = query.text;
      assert.equal(query.values.length % 7, 0);
      for (let index = 0; index < query.values.length; index += 7) {
        const [id, billId, productId, soQty, adminQty, rateWithoutGST, rateWithGST] = query.values.slice(index, index + 7);
        const key = `${billId}:${productId}`;
        const existing = rows.get(key);
        rows.set(key, existing ? {
          ...existing,
          soQty: soQty == null ? existing.soQty : number(soQty),
          adminQty: adminQty == null ? existing.adminQty : number(adminQty),
          rateWithoutGST: number(rateWithoutGST)!, rateWithGST: number(rateWithGST)!,
        } : {
          id: String(id), billId: String(billId), productId: String(productId),
          soQty: number(soQty), adminQty: number(adminQty),
          rateWithoutGST: number(rateWithoutGST)!, rateWithGST: number(rateWithGST)!, createdAt: "new-created-at",
        });
      }
      return query.values.length / 7;
    },
  };

  await service.upsertBillProducts(db as never, [
    { billId: "bill-1", productId: "p1", adminQty: 12.345, rateWithoutGST: 100, rateWithGST: 118 },
    { billId: "bill-1", productId: "p2", adminQty: 5, rateWithoutGST: 200, rateWithGST: 236 },
    { billId: "bill-2", productId: "p1", soQty: 3, adminQty: 4, rateWithoutGST: 100, rateWithGST: 118 },
  ]);
  assert.match(lastSql, /ON CONFLICT \("billId","productId"\) DO UPDATE/);
  assert.equal(executeCalls, 1);
  assert.equal(rows.get("bill-1:p1")?.id, "historical-id");
  assert.equal(rows.get("bill-1:p1")?.createdAt, "historical-created-at");
  assert.equal(rows.get("bill-1:p1")?.soQty, 10);
  assert.equal(rows.get("bill-1:p1")?.adminQty, 12.345);
  assert.equal(rows.get("bill-1:p1")?.rateWithoutGST, 100);
  assert.equal(rows.get("bill-1:p2")?.adminQty, 5);
  assert.equal(rows.get("bill-2:p1")?.soQty, 3);
  console.log("PASS bulk SQL updates existing rows and creates mixed new rows without replacing identity or SO quantity");

  rows.clear();
  const large = Array.from({ length: 1000 }, (_, index) => ({
    billId: `bill-${Math.floor(index / 200) + 1}`, productId: `product-${index % 200 + 1}`,
    adminQty: index / 1000, rateWithoutGST: 100, rateWithGST: 118,
  }));
  await service.upsertBillProducts(db as never, large);
  assert.equal(executeCalls, 2);
  assert.equal(rows.size, 1000);
  console.log("PASS 1,000 bill-product rows use one parameterized bulk UPSERT call");
}

type VerificationState = {
  billWrite: boolean; installments: Record<string, unknown>[]; planUpdate: Record<string, unknown> | null;
  products: Record<string, unknown>[]; bookingCoverage: boolean; audits: Record<string, unknown>[];
};

function verificationHarness(options: {
  billCount?: number;
  products?: number;
  structure?: "FIXED" | "MULTIPLE_OPTIONS";
  requirementType?: string | null;
  optionAchievementType?: string | null;
  quantityTarget?: boolean;
  fail?: "products" | "installments" | "booking";
}) {
  const billCount = options.billCount ?? 5;
  const productCount = options.products ?? 200;
  const structure = options.structure ?? "FIXED";
  const quantityTarget = options.quantityTarget ?? true;
  const committed = Array.from({ length: productCount }, (_, index) => ({
    productId: `product-${index + 1}`, name: `Product ${index + 1}`,
    committedQty: quantityTarget ? billCount : null,
    rateWithoutGST: 100, rateWithGST: 118, historicalSnapshot: true,
  }));
  let proceedingUnits = 0;
  let bulkCalls = 0;
  let timeout: number | undefined;
  let committedState: VerificationState = { billWrite: false, installments: [], planUpdate: null, products: [], bookingCoverage: false, audits: [] };
  const source = {
    salesOfficerId: "officer", schemeId: "scheme", numberOfSchemes: 2, totalSchemeAmount: 23600,
    optionTargetQty: quantityTarget ? 5 : null, billMode: true, soBillCount: billCount,
    optionValueWithoutGST: structure === "MULTIPLE_OPTIONS" ? 100000 : null,
    optionValueWithGST: structure === "MULTIPLE_OPTIONS" ? 118000 : null,
    optionBookingAmount: 0,
    scheme: {
      structure,
      requirementType: options.requirementType ?? (quantityTarget && structure === "FIXED" ? "PRODUCT_BASED" : "VALUE_BASED"),
      optionAchievementType: options.optionAchievementType ?? (quantityTarget && structure === "MULTIPLE_OPTIONS" ? "QUANTITY_BASED" : structure === "MULTIPLE_OPTIONS" ? "VALUE_BASED" : null),
      schemeValueWithoutGST: 100000, schemeValueWithGST: 118000, bookingAmount: 0, numberOfBills: 5,
      installmentRules: [{ installmentNumber: 1, calculationType: "PERCENTAGE", value: 100, daysAfterBillingDate: 0 }],
    },
  };
  const lockedPlan = {
    salesOfficerId: "officer", planStatus: "APPROVED", schemeStatus: "CONVERTED", enrollmentStatus: "PENDING_DOCUMENT",
    billMode: true, soBillCount: billCount, adminBillCount: null, soAmountWithoutGST: null, soAmountWithGST: null,
    adminAmountWithoutGST: null, adminAmountWithGST: null, bookingAmount: null, bookingBillNumber: null, billsLockedAt: null,
    installmentBalance: false, conversionDate: new Date("2026-09-01"), soBookingStatus: "RECEIVED", soBookingAmount: 0,
    soDocumentStatus: "DOC_RECEIVED", adminConversionDate: null, adminBookingStatus: null, adminBookingAmount: null,
    adminDocumentStatus: null, adminVerifiedAt: null, enrolledAt: null, prePlacementDays: null, adminPrePlacementDays: null,
  };
  const billIds = Array.from({ length: billCount }, (_, index) => ({ id: `bill-${index + 1}`, partNumber: index + 1 }));

  const prisma = {
    dealerSchemePlan: { findUnique: async () => source },
    $transaction: async (fn: (tx: Record<string, unknown>) => Promise<unknown>, transactionOptions?: { timeout?: number }) => {
      timeout = transactionOptions?.timeout;
      const working = structuredClone(committedState);
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join("?");
          if (sql.includes("FOR UPDATE")) return [{ id: "plan" }];
          if (sql.includes('INSERT INTO "DealerSchemeBill"')) { working.billWrite = true; return billIds; }
          throw new Error(`Unexpected query: ${sql}`);
        },
        $executeRaw: async () => {
          if (options.fail === "booking") throw new Error("injected booking update failure");
          working.bookingCoverage = true;
          return 1;
        },
        dealerSchemePlan: {
          findUnique: async () => lockedPlan,
          update: async ({ data }: { data: Record<string, unknown> }) => { working.planUpdate = structuredClone(data); },
        },
        dealerSchemeBill: {
          findMany: async ({ select }: { select: Record<string, unknown> }) => "partNumber" in select && Object.keys(select).length === 2 ? billIds : [],
        },
        dealerSchemeInstallment: {
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            working.installments.push(...structuredClone(data));
            if (options.fail === "installments") throw new Error("injected installment failure");
            return { count: data.length };
          },
        },
        billProducts: {
          upsertMany: async (rows: Record<string, unknown>[]) => {
            bulkCalls++;
            working.products.push(...structuredClone(rows));
            if (options.fail === "products") throw new Error("injected product bulk failure");
          },
        },
        auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { working.audits.push(structuredClone(data)); } },
      };
      try {
        const result = await fn(tx);
        committedState = working;
        return result;
      } catch (error) {
        throw error;
      }
    },
  };
  const productModule = {
    isProductQuantityScheme: () => quantityTarget,
    usesProductRateBilling: () => true,
    committedProductsForScheme: async (_schemeId: string, _structure: string, _optionType: string | null, _requirementType: string | null, _target: number | null, units: number) => {
      proceedingUnits = units;
      return committed;
    },
    upsertBillProduct: async () => {},
    upsertBillProducts: async (tx: { billProducts: { upsertMany(rows: Record<string, unknown>[]): Promise<void> } }, rows: Record<string, unknown>[]) => tx.billProducts.upsertMany(rows),
  };
  const service = loadService<typeof import("./scheme-bills.server")>("scheme-bills.server.ts", prisma, { "./scheme-bill-product.server": productModule });
  const bills = Array.from({ length: billCount }, (_, billIndex) => ({
    partNumber: billIndex + 1,
    adminBillDate: `2026-10-${String(billIndex + 1).padStart(2, "0")}`,
    amountWithoutGST: "1", amountWithGST: "1",
    products: committed.map((product) => ({ productId: product.productId, qty: 1 })),
  }));
  const raw = { billCount, amountWithoutGST: "1", amountWithGST: "1", bills };
  const common = {
    adminConversionDate: new Date("2026-09-01"), adminBookingStatus: "RECEIVED" as const,
    adminBookingAmount: 0, adminBookingSchemeCount: 1, adminDocumentStatus: "RECEIVED_SOFT",
  };
  return { service, raw, common, state: () => structuredClone(committedState), bulkCalls: () => bulkCalls, timeout: () => timeout, proceedingUnits: () => proceedingUnits };
}

async function testVerification() {
  const ctx = { userId: "admin", role: "SUPER_ADMIN", groupId: null } as AuthContext;
  const large = verificationHarness({});
  const result = await large.service.verifyBills(ctx, "plan", large.common, large.raw);
  assert.equal(JSON.stringify(result), JSON.stringify({ enrolled: true, eligible: true }));
  assert.equal(large.bulkCalls(), 1);
  assert.equal(large.state().products.length, 1000);
  assert.equal(large.state().installments.length, 5);
  assert.equal(large.state().planUpdate?.adminAmountWithoutGST, "100000.00");
  assert.equal(large.state().planUpdate?.adminAmountWithGST, "118000.00");
  assert.equal(large.state().products[0].adminQty, 1);
  assert.equal(large.state().products[0].rateWithoutGST, 100);
  assert.equal(large.proceedingUnits(), 2);
  assert.equal(large.timeout(), 15000);
  console.log("PASS Admin verifies 5 bills × 200 products with one bulk write, historical rates, direct actual quantities, installments, and a scoped timeout");

  for (const failure of ["products", "installments", "booking"] as const) {
    const h = verificationHarness({ products: 3, fail: failure });
    await assert.rejects(h.service.verifyBills(ctx, "plan", h.common, h.raw), /injected/);
    assert.deepEqual(h.state(), { billWrite: false, installments: [], planUpdate: null, products: [], bookingCoverage: false, audits: [] });
  }
  console.log("PASS product, installment, and booking failures roll back the complete Admin Verification transaction");

  for (const structure of ["FIXED", "MULTIPLE_OPTIONS"] as const) {
    const h = verificationHarness({ billCount: 1, products: 1, structure, quantityTarget: false });
    const row = h.raw.bills[0];
    row.products[0].qty = 500;
    await h.service.verifyBills(ctx, "plan", h.common, h.raw);
    assert.equal(h.state().planUpdate?.adminAmountWithoutGST, "50000.00");
    assert.equal(h.state().planUpdate?.adminAmountWithGST, "59000.00");
  }
  console.log("PASS Fixed and Options Value Based Admin verification retain quantity × historical-rate behavior");
}

async function main() {
  await testBulkSql();
  await testVerification();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
