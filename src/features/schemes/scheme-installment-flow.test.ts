/** Database-free service contract tests: run actual services against deliberately limited persistence mocks. */
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
    "./scheme-bills.server": { billFinancialScope: {}, rejectLegacyBillWrite: async () => {} },
    "./scheme-plan-quantity.server": { conversionQuantityPlanSelect: {}, applyConversionQuantity: async () => ({ split: false }) },
    "./scheme-bill-product.server": { isProductQuantityScheme: () => false, usesProductRateBilling: () => false, committedProductsForScheme: async () => [], upsertBillProduct: async () => {} },
    "server-only": {}, "@/lib/prisma": { prisma }, "@/lib/audit": { writeAudit: async () => {} },
    "@/lib/http": { ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } },
    "@/lib/scope": { getOfficerScope: async () => ({ all: true, ids: [] }), assertOfficerInScope: async () => {}, getCurrentManagerId: async () => null },
    "./scheme-master.server": { refreshSchemeStatuses: async () => {} },
    "./scheme-planning.server": { ensureInstances: async () => [{ id: "instance", instanceNumber: 1 }] },
    ...overrides,
  };
  runInNewContext(code, { exports, Date, console, require: (id: string) => id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id) }, { filename });
  return exports as T;
}

const ctx = { userId: "admin", role: "SUPER_ADMIN", groupId: null } as AuthContext;
const rule = (installmentNumber: number, value: number) => ({ installmentNumber, calculationType: "PERCENTAGE", value, daysAfterBillingDate: installmentNumber * 30 });
const base = { schemeName: "Booking", stateIds: ["state"], isPerpetual: true, schemeBenefit: "CREDIT_NOTE", allowMultipleSchemes: false,
  structure: "MULTIPLE_OPTIONS", optionAchievementType: "VALUE_BASED", eligibleProductIds: ["product"], installmentBalance: true,
  installments: [rule(1, 30), rule(2, 70)], bookingAmount: 999, otherBenefitDetails: "Standard scheme benefit",
  numberOfBills: 5, maxExtensionDays: 15, maxExtensionAttempts: 2, prePlacementMaxDays: 30,
  requirementType: "NONE", valueMode: null, combinedRequiredValue: null, requirementProducts: [],
  productRates: [{ productId: "product", rateWithoutGST: 800, rateWithGST: 1000 }],
  options: [{ valueWithoutGST: 80000, valueWithGST: 100000, bookingAmount: 25000, isActive: true }, { valueWithoutGST: 160000, valueWithGST: 200000, bookingAmount: 35000, isActive: true }],
};

async function main() {
  let written: Record<string, unknown> = {};
  const optionWrites: Record<string, unknown>[] = [];
  let ownedOptions: { id: string; _count: { dealerPlans: number } }[] = [];
  let schemeUpdateCalls = 0;
  const scopedOptionUpdates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const scopedOptionDeletes: Record<string, unknown>[] = [];
  let storedNumberOfBills = 5;
  let conversionActivityCount = 0;
  const tx = {
    scheme: { update: async ({ data }: { data: Record<string, unknown> }) => { schemeUpdateCalls++; written = data; } },
    schemeOption: {
      findMany: async () => ownedOptions,
      updateMany: async ({ where, data }: { where: { schemeId?: string; id?: string | { in: string[] } }; data: Record<string, unknown> }) => {
        const ids = typeof where.id === "string" ? [where.id] : where.id?.in ?? [];
        const count = where.schemeId === "scheme" ? ownedOptions.filter((option) => ids.includes(option.id)).length : 0;
        if (count > 0) scopedOptionUpdates.push({ where, data });
        return { count };
      },
      deleteMany: async ({ where }: { where: { schemeId?: string; id?: { in: string[] } } }) => {
        const count = where.schemeId === "scheme" ? ownedOptions.filter((option) => where.id?.in.includes(option.id)).length : 0;
        if (count > 0) scopedOptionDeletes.push(where);
        return { count };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => { optionWrites.push(data); },
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => { optionWrites.push(...data); },
    },
    $executeRawUnsafe: async () => 0,
  };
  const master = loadService<typeof import("./scheme-master.server")>("scheme-master.server.ts", {
    scheme: { create: async ({ data }: { data: Record<string, unknown> }) => { written = data; return { id: "scheme", schemeName: "Booking" }; },
      findUnique: async () => ({ structure: "MULTIPLE_OPTIONS", numberOfBills: storedNumberOfBills, _count: { dealerPlans: 1 } }), updateMany: async () => {} },
    dealerSchemePlan: { count: async () => conversionActivityCount },
    $transaction: async (fn: (db: typeof tx) => Promise<void>) => fn(tx),
    $executeRawUnsafe: async () => 0,
  });
  await master.createScheme(ctx, base);
  const created = (written.options as { create: { bookingAmount: number; targetValue: number }[] }).create;
  assert.deepEqual(created.map(o => o.bookingAmount), [25000, 35000]);
  assert.deepEqual(created.map(o => o.targetValue), [100000, 200000]);
  assert.equal(written.installmentBalance, true);
  const amountMode = { ...base, installments: [
    { ...rule(1, 30000), calculationType: "FIXED_AMOUNT" },
    { ...rule(2, 0), calculationType: "FIXED_AMOUNT" },
  ] };
  await master.createScheme(ctx, amountMode);
  assert.equal(written.installmentBalance, true);
  assert.deepEqual((written.installmentRules as { create: { calculationType: string; value: number }[] }).create.map(r => [r.calculationType, r.value]), [["FIXED_AMOUNT", 30000], ["FIXED_AMOUNT", 0]]);
  await master.updateScheme(ctx, "scheme", amountMode);
  assert.deepEqual(optionWrites.map(o => o.bookingAmount), [25000, 35000]);
  assert.deepEqual(((written.installmentRules as { create: { calculationType: string; value: number }[] }).create).map(r => [r.calculationType, r.value]), [["FIXED_AMOUNT", 30000], ["FIXED_AMOUNT", 0]]);
  storedNumberOfBills = 3;
  conversionActivityCount = 1;
  await assert.rejects(master.updateScheme(ctx, "scheme", amountMode), /No\. of Bills cannot be changed after conversion/);
  storedNumberOfBills = 5;
  conversionActivityCount = 0;
  await assert.rejects(master.createScheme(ctx, { ...amountMode, installmentBalance: false }), /requires the final installment to be Balance/);
  await assert.rejects(master.createScheme(ctx, { ...amountMode, installments: [{ ...rule(1, 30000), calculationType: "FIXED_AMOUNT" }, { ...rule(2, 70000), calculationType: "FIXED_AMOUNT" }] }), /must be Balance/);
  await assert.rejects(master.createScheme(ctx, { ...amountMode, installments: [{ ...rule(1, 90000), calculationType: "FIXED_AMOUNT" }, { ...rule(2, 0), calculationType: "FIXED_AMOUNT" }] }), /final installment/);
  await assert.rejects(master.createScheme(ctx, { ...base, options: [{ ...base.options[0], bookingAmount: 75000 }] }));
  await assert.rejects(master.createScheme(ctx, { ...base, options: [{ ...base.options[0], bookingAmount: -1 }] }));
  // Fixed Product Quantity values are derived on the server before validation/persistence. Deliberately
  // tampered request totals must not become authoritative.
  const fixed = { ...base, structure: "FIXED", optionAchievementType: null, eligibleProductIds: [], options: [], installmentBalance: false,
    schemeValueWithoutGST: 99999, schemeValueWithGST: 99999, bookingAmount: 25000,
    requirementType: "PRODUCT_BASED", requirementProducts: [{ productId: "product", requiredQty: 1000, requiredValue: null }],
    // Product-Quantity-Based now requires per-product billing rates.
    productRates: [{ productId: "product", rateWithoutGST: 80, rateWithGST: 100 }] };
  await master.createScheme(ctx, { ...fixed, installments: [{ ...rule(1, 100000), calculationType: "FIXED_AMOUNT" }] });
  assert.equal(written.schemeValueWithoutGST, 80000);
  assert.equal(written.schemeValueWithGST, 100000);
  await assert.rejects(master.createScheme(ctx, { ...fixed, installments: [] }), /installment/i);
  await assert.rejects(master.createScheme(ctx, { ...fixed, otherBenefitDetails: "" }), /Other Benefit Details/i);
  await assert.rejects(master.createScheme(ctx, { ...fixed, requirementType: "NONE", requirementProducts: [] }), /Scheme Basis/i);
  await master.createScheme(ctx, {
    ...fixed,
    schemeValueWithoutGST: 1,
    schemeValueWithGST: 1,
    bookingAmount: 0,
    installments: [rule(1, 100)],
    requirementProducts: [
      { productId: "adam", requiredQty: 300, requiredValue: null },
      { productId: "agora", requiredQty: 600, requiredValue: null },
    ],
    productRates: [
      { productId: "adam", rateWithoutGST: 100, rateWithGST: 118 },
      { productId: "agora", rateWithoutGST: 50, rateWithGST: 59 },
    ],
  });
  assert.equal(written.schemeValueWithoutGST, 60000);
  assert.equal(written.schemeValueWithGST, 70800);
  await master.createScheme(ctx, {
    ...fixed,
    bookingAmount: 0,
    installments: [rule(1, 100)],
    requirementProducts: [{ productId: "product", requiredQty: 12.345, requiredValue: null }],
    productRates: [{ productId: "product", rateWithoutGST: 100, rateWithGST: 118 }],
  });
  assert.equal(written.schemeValueWithoutGST, 1234.5);
  assert.equal(written.schemeValueWithGST, 1456.71);

  const quantityOptions = {
    ...base,
    optionAchievementType: "QUANTITY_BASED",
    bookingAmount: 0,
    productRates: [{ productId: "product", rateWithoutGST: 100, rateWithGST: 118 }],
    options: [
      { target: 300, valueWithoutGST: 99999, valueWithGST: 99999, bookingAmount: 0, isActive: true },
      { target: 200, valueWithoutGST: 1, valueWithGST: 1, bookingAmount: 0, isActive: true },
    ],
  };
  await master.createScheme(ctx, quantityOptions);
  const quantityOptionWrites = (written.options as { create: { valueWithoutGST: number; valueWithGST: number }[] }).create;
  assert.deepEqual(quantityOptionWrites.map((o) => [o.valueWithoutGST, o.valueWithGST]), [[30000, 35400], [20000, 23600]]);
  optionWrites.length = 0;
  ownedOptions = ["option-1", "option-2"].map((id) => ({ id, _count: { dealerPlans: 0 } }));
  await master.updateScheme(ctx, "scheme", { ...quantityOptions, options: quantityOptions.options.map((option, index) => ({ ...option, id: `option-${index + 1}` })) });
  assert.equal(JSON.stringify(scopedOptionUpdates.slice(-2).map((write) => [write.where, write.data.valueWithoutGST, write.data.valueWithGST])), JSON.stringify([
    [{ id: "option-1", schemeId: "scheme" }, 30000, 35400],
    [{ id: "option-2", schemeId: "scheme" }, 20000, 23600],
  ]));

  const schemeWritesBeforeAttack = schemeUpdateCalls;
  const optionWritesBeforeAttack = scopedOptionUpdates.length;
  const optionDeletesBeforeAttack = scopedOptionDeletes.length;
  await assert.rejects(master.updateScheme(ctx, "scheme", {
    ...quantityOptions,
    options: [
      { ...quantityOptions.options[0], id: "option-1" },
      { ...quantityOptions.options[1], id: "foreign-option" },
    ],
  }), /Scheme option not found/);
  assert.equal(schemeUpdateCalls, schemeWritesBeforeAttack); // ownership is rejected before any Scheme A write
  assert.equal(scopedOptionUpdates.length, optionWritesBeforeAttack); // foreign option is never updated/reordered
  assert.equal(scopedOptionDeletes.length, optionDeletesBeforeAttack); // omission reconciliation never runs

  await master.updateScheme(ctx, "scheme", {
    ...quantityOptions,
    options: [{ ...quantityOptions.options[0], id: "option-1" }],
  });
  assert.equal(JSON.stringify(scopedOptionDeletes.at(-1)), JSON.stringify({ schemeId: "scheme", id: { in: ["option-2"] } }));
  assert.equal(JSON.stringify(scopedOptionUpdates.at(-1)?.where), JSON.stringify({ id: "option-1", schemeId: "scheme" }));
  const fixedValue = { ...fixed,
    requirementType: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 100000,
    schemeValueWithoutGST: 80000, schemeValueWithGST: 100000,
    requirementProducts: [{ productId: "product", requiredQty: null, requiredValue: null }],
    productRates: [{ productId: "product", rateWithoutGST: 212, rateWithGST: 250 }],
  };
  await master.createScheme(ctx, fixedValue); // Value Based does not require a product quantity.
  assert.equal(written.schemeValueWithoutGST, 80000);
  assert.equal(written.schemeValueWithGST, 100000);
  await assert.rejects(master.createScheme(ctx, { ...fixedValue, schemeValueWithoutGST: null }), /Scheme Value \(Without GST\) is required/);
  await assert.rejects(master.createScheme(ctx, { ...fixedValue, requirementProducts: [], productRates: [] }), /product/i);
  await assert.rejects(master.createScheme(ctx, { ...fixedValue, productRates: [] }), /Rate W\/O GST/);
  await assert.rejects(master.createScheme(ctx, { ...fixedValue, productRates: [{ productId: "product", rateWithoutGST: 212, rateWithGST: 0 }] }), /greater than 0|Rate W\/O GST/);
  await master.createScheme(ctx, {
    ...fixedValue,
    requirementProducts: [
      { productId: "product", requiredQty: null, requiredValue: null },
      { productId: "product-2", requiredQty: null, requiredValue: null },
    ],
    productRates: [
      { productId: "product", rateWithoutGST: 212, rateWithGST: 250 },
      { productId: "product-2", rateWithoutGST: 300, rateWithGST: 354 },
    ],
  });
  assert.equal(JSON.stringify((written.requirementProducts as { create: unknown[] }).create), JSON.stringify([
    { productId: "product", requiredQty: null, requiredValue: null, rateWithoutGST: 212, rateWithGST: 250 },
    { productId: "product-2", requiredQty: null, requiredValue: null, rateWithoutGST: 300, rateWithGST: 354 },
  ]));
  await assert.rejects(master.createScheme(ctx, { ...base, options: [{ ...base.options[0], valueWithGST: 79999 }] }), /With GST/i);
  await assert.rejects(master.createScheme(ctx, { ...base, options: [{ ...base.options[0], bookingAmount: null }] }), /Booking Amount/i);
  await assert.rejects(master.createScheme(ctx, { ...base, options: [{ ...base.options[0], valueWithoutGST: null }] }), /Without GST|positive/i);
  await assert.rejects(master.createScheme(ctx, { ...base, productRates: [] }), /Rate W\/O GST/);
  await assert.rejects(master.createScheme(ctx, { ...base, productRates: [{ productId: "product", rateWithoutGST: 800, rateWithGST: 0 }] }), /greater than 0|Rate W\/O GST/);
  await master.createScheme(ctx, { ...base, options: [{ ...base.options[0], target: null }] }); // Value Based never requires product quantity.
  ownedOptions = ["value-option-1", "value-option-2"].map((id) => ({ id, _count: { dealerPlans: 0 } }));
  await master.updateScheme(ctx, "scheme", { ...base, options: base.options.map((option, index) => ({ ...option, id: `value-option-${index + 1}` })) });
  assert.deepEqual(scopedOptionUpdates.slice(-2).map((write) => [write.data.valueWithoutGST, write.data.valueWithGST]), [[80000, 100000], [160000, 200000]]);
  await assert.rejects(master.createScheme(ctx, { ...base, eligibleProductIds: ["product", "product-2"], productRates: base.productRates }), /every eligible product/);
  await master.createScheme(ctx, { ...base, eligibleProductIds: ["product", "product-2"], productRates: [...base.productRates, { productId: "product-2", rateWithoutGST: 300, rateWithGST: 354 }] });
  assert.equal(JSON.stringify((written.eligibleProducts as { create: unknown[] }).create), JSON.stringify([
    { productId: "product", rateWithoutGST: 800, rateWithGST: 1000 },
    { productId: "product-2", rateWithoutGST: 300, rateWithGST: 354 },
  ]));
  await assert.rejects(master.createScheme(ctx, { ...base, numberOfBills: undefined }), /number/i);
  console.log("PASS master create/edit server-derives Product Quantity values and preserves Value Based validation");

  let conversionTransactions = 0;
  let conversionTimeout: number | undefined;
  let configuredBillMaximum = 5;
  const bills = loadService<typeof import("./scheme-bills.server")>("scheme-bills.server.ts", {
    dealerSchemePlan: { findUnique: async () => ({
      salesOfficerId: "admin", numberOfSchemes: 4, totalSchemeAmount: 400000, soBillCount: null,
      optionValueWithoutGST: null, optionValueWithGST: null, optionBookingAmount: null,
      scheme: { structure: "FIXED", schemeValueWithoutGST: 80000, schemeValueWithGST: 100000, bookingAmount: 0, numberOfBills: configuredBillMaximum, installmentRules: [] },
    }) },
    $transaction: async (_fn: unknown, options?: { timeout?: number }) => { conversionTransactions++; conversionTimeout = options?.timeout; return { ok: true }; },
  });
  const conversionBilling = (amountWithoutGST: string, amountWithGST: string) => ({
    billCount: 1, amountWithoutGST, amountWithGST,
    bills: [{ partNumber: 1, soBillDate: "2026-09-20", amountWithoutGST, amountWithGST }],
  });
  await assert.rejects(bills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, conversionBilling("319999.99", "400000")), /Without GST.*₹3,20,000/);
  await assert.rejects(bills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, conversionBilling("320000", "399999.99")), /With GST.*₹4,00,000/);
  assert.equal(conversionTransactions, 0);
  configuredBillMaximum = 3;
  await assert.rejects(bills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, {
    billCount: 4, amountWithoutGST: "320000", amountWithGST: "400000",
    bills: [1, 2, 3, 4].map((partNumber) => ({ partNumber, soBillDate: "2026-09-20", amountWithoutGST: "80000", amountWithGST: "100000" })),
  }), /Scheme Master limit of 3/);
  assert.equal(conversionTransactions, 0);
  configuredBillMaximum = 5;
  await bills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, conversionBilling("320000", "400000"));
  assert.equal(conversionTransactions, 1);
  await bills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED", proceedingSchemes: 2, remainingDisposition: "CANCELLED" }, conversionBilling("160000", "200000"));
  assert.equal(conversionTransactions, 2); // selected quantity uses the same frozen per-scheme values
  assert.equal(conversionTimeout, 15000);
  console.log("PASS SO conversion enforces combined preset minimums before its transaction");

  let valueConversionTransactions = 0;
  const valueBills = loadService<typeof import("./scheme-bills.server")>("scheme-bills.server.ts", {
    dealerSchemePlan: { findUnique: async () => ({
      salesOfficerId: "admin", schemeId: "scheme", numberOfSchemes: 1, totalSchemeAmount: 118000,
      optionTargetQty: null, optionValueWithoutGST: 100000, optionValueWithGST: 118000, optionBookingAmount: 0,
      billMode: false, soBillCount: null,
      scheme: { structure: "MULTIPLE_OPTIONS", requirementType: null, optionAchievementType: "VALUE_BASED", schemeValueWithoutGST: null, schemeValueWithGST: null, bookingAmount: 0, numberOfBills: 5, installmentRules: [] },
    }) },
    $transaction: async () => { valueConversionTransactions++; return { ok: true }; },
  }, {
    "./scheme-bill-product.server": {
      isProductQuantityScheme: () => false,
      usesProductRateBilling: () => true,
      committedProductsForScheme: async () => [{ productId: "adhbut", name: "ADHBUT", committedQty: null, rateWithoutGST: 212, rateWithGST: 250 }],
      upsertBillProduct: async () => {},
    },
  });
  const valueBilling = (qty: number) => ({
    billCount: 1, amountWithoutGST: "1", amountWithGST: "1",
    bills: [{ partNumber: 1, soBillDate: "2026-09-20", amountWithoutGST: "1", amountWithGST: "1", products: [{ productId: "adhbut", qty }] }],
  });
  await assert.rejects(valueBills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, valueBilling(400)), /Without GST.*₹1,00,000/);
  assert.equal(valueConversionTransactions, 0);
  await valueBills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, valueBilling(500));
  assert.equal(valueConversionTransactions, 1);
  console.log("PASS Options Value conversion derives amounts from quantity × rate and enforces its selected Option target");

  let capturedProceedingUnits = 0;
  let quantityConversionTransactions = 0;
  const quantityBills = loadService<typeof import("./scheme-bills.server")>("scheme-bills.server.ts", {
    dealerSchemePlan: { findUnique: async () => ({
      salesOfficerId: "admin", schemeId: "scheme", numberOfSchemes: 4, totalSchemeAmount: 47200,
      optionTargetQty: null, optionValueWithoutGST: null, optionValueWithGST: null, optionBookingAmount: null,
      billMode: false, soBillCount: null,
      scheme: { structure: "FIXED", requirementType: "PRODUCT_BASED", optionAchievementType: null, schemeValueWithoutGST: 40000, schemeValueWithGST: 47200, bookingAmount: 0, numberOfBills: 5, installmentRules: [] },
    }) },
    $transaction: async () => { quantityConversionTransactions++; return { ok: true }; },
  }, {
    "./scheme-bill-product.server": {
      isProductQuantityScheme: () => true,
      usesProductRateBilling: () => true,
      committedProductsForScheme: async (_schemeId: string, _structure: string, _optionType: string | null, _requirementType: string, _optionTarget: number | null, proceedingUnits: number) => {
        capturedProceedingUnits = proceedingUnits;
        return [{ productId: "adam", name: "ADAM", committedQty: 100 * proceedingUnits, rateWithoutGST: 100, rateWithGST: 118 }];
      },
      upsertBillProduct: async () => {},
    },
  });
  const quantityBilling = (qty: number) => ({
    billCount: 1, amountWithoutGST: "1", amountWithGST: "1",
    bills: [{ partNumber: 1, soBillDate: "2026-09-20", amountWithoutGST: "1", amountWithGST: "1", products: [{ productId: "adam", qty }] }],
  });
  await assert.rejects(quantityBills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED", proceedingSchemes: 2, remainingDisposition: "FUTURE_DRAFT" }, quantityBilling(150)), /must total its committed quantity of 200/);
  assert.equal(quantityConversionTransactions, 0);
  await quantityBills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED", proceedingSchemes: 2, remainingDisposition: "FUTURE_DRAFT" }, quantityBilling(200));
  assert.equal(capturedProceedingUnits, 2);
  assert.equal(quantityConversionTransactions, 1);
  console.log("PASS Product Quantity conversion validates against the effective proceeding segment quantity");

  let fixedValueConversionTransactions = 0;
  const fixedValueBills = loadService<typeof import("./scheme-bills.server")>("scheme-bills.server.ts", {
    dealerSchemePlan: { findUnique: async () => ({
      salesOfficerId: "admin", schemeId: "scheme", numberOfSchemes: 1, totalSchemeAmount: 118000,
      optionTargetQty: null, optionValueWithoutGST: null, optionValueWithGST: null, optionBookingAmount: null,
      billMode: false, soBillCount: null,
      scheme: { structure: "FIXED", requirementType: "VALUE_BASED", optionAchievementType: null, schemeValueWithoutGST: 100000, schemeValueWithGST: 118000, bookingAmount: 0, numberOfBills: 5, installmentRules: [] },
    }) },
    $transaction: async () => { fixedValueConversionTransactions++; return { ok: true }; },
  }, {
    "./scheme-bill-product.server": {
      isProductQuantityScheme: () => false,
      usesProductRateBilling: () => true,
      committedProductsForScheme: async () => [{ productId: "adhbut", name: "ADHBHUT", committedQty: null, rateWithoutGST: 212, rateWithGST: 250 }],
      upsertBillProduct: async () => {},
    },
  });
  await assert.rejects(fixedValueBills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, valueBilling(400)), /Without GST.*₹1,00,000/);
  assert.equal(fixedValueConversionTransactions, 0);
  await fixedValueBills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, valueBilling(500));
  assert.equal(fixedValueConversionTransactions, 1);
  console.log("PASS Fixed Value conversion derives ₹1,06,000 from 500 × ₹212 and enforces its scheme target");

  let snapshotQueries = 0;
  const productBillingService = loadService<typeof import("./scheme-bill-product.server")>("scheme-bill-product.server.ts", {
    $queryRaw: async () => {
      snapshotQueries++;
      return [{ productId: "removed-product", name: "Historical Product", soQty: 500, rateWithoutGST: 212, rateWithGST: 250 }];
    },
  });
  const snapshottedProducts = await productBillingService.committedProductsForScheme("scheme", "MULTIPLE_OPTIONS", "VALUE_BASED", null, null, 1, "plan");
  assert.equal(JSON.stringify(snapshottedProducts.map((product) => [product.productId, product.rateWithoutGST, product.rateWithGST, product.historicalSnapshot])), JSON.stringify([["removed-product", 212, 250, true]]));
  assert.equal(snapshotQueries, 1); // current SchemeEligibleProduct rows/rates were not re-read after a snapshot existed
  console.log("PASS historical bill-product rates and removed products remain authoritative");

  const fixedProductBillingService = loadService<typeof import("./scheme-bill-product.server")>("scheme-bill-product.server.ts", {
    $queryRaw: async () => [{ productId: "product", name: "Product", requiredQty: null, rateWithoutGST: 212, rateWithGST: 250 }],
  });
  assert.equal(fixedProductBillingService.usesProductRateBilling("FIXED", "VALUE_BASED", null), true);
  assert.equal(fixedProductBillingService.isProductQuantityScheme("FIXED", "VALUE_BASED", null), false);
  const fixedValueProducts = await fixedProductBillingService.committedProductsForScheme("scheme", "FIXED", null, "VALUE_BASED", null, 1);
  assert.equal(JSON.stringify(fixedValueProducts.map((product) => [product.productId, product.committedQty, product.rateWithoutGST, product.rateWithGST])), JSON.stringify([["product", null, 212, 250]]));
  console.log("PASS Fixed Value product-rate billing has a monetary target and no committed quantity");

  const fixedQuantityProducts = loadService<typeof import("./scheme-bill-product.server")>("scheme-bill-product.server.ts", {
    $queryRaw: async () => [{ productId: "adam", name: "ADAM", requiredQty: 100, rateWithoutGST: 100, rateWithGST: 118 }],
  });
  const fixedThree = await fixedQuantityProducts.committedProductsForScheme("scheme", "FIXED", null, "PRODUCT_BASED", null, 3);
  assert.equal(JSON.stringify(fixedThree.map((product) => [product.perSchemeCommittedQty, product.committedQty])), JSON.stringify([[100, 300]]));
  const optionQuantityProducts = loadService<typeof import("./scheme-bill-product.server")>("scheme-bill-product.server.ts", {
    $queryRaw: async () => [{ productId: "adam", name: "ADAM", rateWithoutGST: 100, rateWithGST: 118 }],
  });
  const selectedOptionThree = await optionQuantityProducts.committedProductsForScheme("scheme", "MULTIPLE_OPTIONS", "QUANTITY_BASED", null, 200, 3);
  assert.equal(JSON.stringify(selectedOptionThree.map((product) => [product.perSchemeCommittedQty, product.committedQty])), JSON.stringify([[200, 600]]));
  const historicalQuantityProducts = loadService<typeof import("./scheme-bill-product.server")>("scheme-bill-product.server.ts", {
    $queryRaw: async () => [
      { productId: "adam", name: "ADAM", soQty: 100, rateWithoutGST: 100, rateWithGST: 118 },
      { productId: "adam", name: "ADAM", soQty: 200, rateWithoutGST: 100, rateWithGST: 118 },
    ],
  });
  const historicalThree = await historicalQuantityProducts.committedProductsForScheme("scheme", "MULTIPLE_OPTIONS", "QUANTITY_BASED", null, 200, 3, "plan");
  assert.equal(JSON.stringify(historicalThree.map((product) => [product.perSchemeCommittedQty ?? null, product.committedQty, product.historicalSnapshot])), JSON.stringify([[null, 300, true]]));
  console.log("PASS Fixed/Options Product Quantity targets scale once and historical bill snapshots remain totals");

  let lockQueries = 0;
  let lockedReads = 0;
  let billWrites = 0;
  let planWrites = 0;
  let appliedWithLockedPlan = false;
  const lockedPlan = {
    id: "plan", salesOfficerId: "admin", numberOfSchemes: 4, totalSchemeAmount: 400000,
    optionValueWithoutGST: null, optionValueWithGST: null,
    scheme: { structure: "FIXED", schemeValueWithoutGST: 80000, schemeValueWithGST: 100000, numberOfBills: 5 },
    planStatus: "APPROVED", schemeStatus: "PENDING", enrollmentStatus: "PENDING_DOCUMENT", billMode: false,
    billsLockedAt: null, soBillCount: null, soAmountWithoutGST: null, soAmountWithGST: null,
    adminVerifiedAt: null, adminPrePlacementDays: null, prePlacementDays: null,
  };
  const billTx = {
    $queryRaw: async () => { lockQueries++; return [{ id: "plan" }]; },
    $executeRaw: async () => { billWrites++; return 1; },
    dealerSchemePlan: {
      findUnique: async () => { lockedReads++; return lockedPlan; },
      update: async () => { planWrites++; },
    },
    dealerSchemeInstallment: { count: async () => 0 },
    dealerSchemeInstance: { count: async () => 0 },
    dealerSchemeBill: { findMany: async () => [] },
  };
  let focusedTimeout: number | undefined;
  const focusedBills = loadService<typeof import("./scheme-bills.server")>("scheme-bills.server.ts", {
    dealerSchemePlan: { findUnique: async () => ({
      salesOfficerId: "admin", numberOfSchemes: 4, totalSchemeAmount: 400000, soBillCount: null,
      optionValueWithoutGST: null, optionValueWithGST: null, optionBookingAmount: null,
      scheme: { structure: "FIXED", schemeValueWithoutGST: 80000, schemeValueWithGST: 100000, bookingAmount: 0, numberOfBills: 5, installmentRules: [] },
    }) },
    $transaction: async (fn: (db: typeof billTx) => Promise<unknown>, options?: { timeout?: number }) => {
      focusedTimeout = options?.timeout;
      return fn(billTx);
    },
  }, {
    "./scheme-plan-quantity.server": {
      conversionQuantityPlanSelect: {},
      applyConversionQuantity: async (_tx: unknown, _ctx: unknown, _id: unknown, _input: unknown, plan: unknown) => {
        appliedWithLockedPlan = plan === lockedPlan;
        return { split: true };
      },
    },
  });
  await focusedBills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED", proceedingSchemes: 2, remainingDisposition: "FUTURE_DRAFT" }, conversionBilling("160000", "200000"));
  assert.deepEqual({ lockQueries, lockedReads, billWrites, planWrites, focusedTimeout, appliedWithLockedPlan }, {
    lockQueries: 1, lockedReads: 1, billWrites: 1, planWrites: 1, focusedTimeout: 15000, appliedWithLockedPlan: true,
  });
  console.log("PASS combined billing reuses one locked plan and writes bills in the scoped transaction");

  let saved: Record<string, unknown> = {};
  let currentState = "DRAFT";
  const option = { id: "option", label: "Legacy label", targetValue: 100000, targetQty: null, valueWithoutGST: 80000, valueWithGST: 100000, bookingAmount: 25000, isActive: true };
  const planPrisma: Record<string, unknown> = {
    scheme: { findUnique: async () => ({ status: "OPEN", isPerpetual: true, startDate: null, endDate: null, allowMultipleSchemes: false,
      schemeValueWithGST: null, structure: "MULTIPLE_OPTIONS", bookingAmount: 999, installmentBalance: true, prePlacementMaxDays: 0, states: [], options: [option] }) },
    dealerAssignment: { findMany: async () => [{ dealerId: "dealer" }] },
    dealerSchemePlan: {
      findMany: async () => [{ id: "plan", dealerId: "dealer", planStatus: currentState }],
      findUnique: async () => null, // instance expansion is unrelated to this snapshot test
      update: async ({ data }: { data: Record<string, unknown> }) => { saved = data; },
    },
    dealerSchemeInstance: { findMany: async () => [], createMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) },
  };
  planPrisma.$transaction = async (fn: (db: typeof planPrisma) => Promise<unknown>) => fn(planPrisma);
  const planService = loadService<typeof import("./scheme-planning.server")>("scheme-planning.server.ts", planPrisma);
  const draft = { schemeId: "scheme", dealers: [{ dealerId: "dealer", optionId: "option", expectedBillingDate: "2026-09-20" }] };
  await planService.saveSchemeDraft({ ...ctx, role: "SALES_OFFICER" }, draft);
  assert.equal(saved.optionBookingAmount, undefined);
  await planService.submitSchemeDraft({ ...ctx, role: "SALES_OFFICER" }, draft);
  assert.equal(saved.optionBookingAmount, 25000);
  assert.equal(saved.installmentBalance, true);
  const snapshot = saved;
  option.bookingAmount = 9000;
  currentState = "APPROVED";
  await planService.submitSchemeDraft({ ...ctx, role: "SALES_OFFICER" }, draft);
  assert.equal(saved, snapshot); // locked plans were not updated
  console.log("PASS submission freezes booking/mode; master edits do not overwrite approved snapshots");

  let existing = false;
  let rows: { plannedAmount: number; plannedDate: Date }[] = [];
  let scheduleRules = base.installments;
  const enrolled = loadService<typeof import("./scheme-enrolled.server")>("scheme-enrolled.server.ts", {
    dealerSchemePlan: { findUnique: async () => ({ billMode: false }) },
    dealerSchemeInstallment: { count: async () => existing ? 2 : 0, createMany: async ({ data }: { data: typeof rows }) => { rows = data; } },
    dealerSchemeInstance: { findUnique: async () => ({ adminBillingDate: new Date("2026-09-01"), dealerSchemePlan: {
      adminVerifiedAt: new Date("2026-09-01"), adminBillingDate: null, billingDate: null, expectedBillingDate: null,
      prePlacementDays: 15, adminPrePlacementDays: null, optionValueWithGST: 100000, optionBookingAmount: snapshot.optionBookingAmount,
      installmentBalance: snapshot.installmentBalance, scheme: { structure: "MULTIPLE_OPTIONS", schemeValueWithGST: null, bookingAmount: 999, installmentRules: scheduleRules },
    } }) },
  });
  await enrolled.ensureAllInstallments("plan");
  assert.deepEqual(Array.from(rows, r => r.plannedAmount), [30000, 45000]);
  assert.equal(rows[0].plannedDate.toISOString().slice(0, 10), "2026-10-16");
  const generated = rows;
  existing = true;
  await enrolled.ensureAllInstallments("plan");
  assert.equal(rows, generated); // no regeneration/update/payment mutation methods even exist in this mock
  existing = false;
  rows = [];
  scheduleRules = amountMode.installments;
  await enrolled.ensureAllInstallments("plan");
  assert.deepEqual(Array.from(rows, r => r.plannedAmount), [30000, 45000]);
  console.log("PASS Percentage and Options Amount generation use snapshot booking; existing schedules bypass writes");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
