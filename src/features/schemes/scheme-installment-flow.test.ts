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
    "server-only": {}, "@/lib/prisma": { prisma }, "@/lib/audit": { writeAudit: async () => {} },
    "@/lib/http": { ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } },
    "@/lib/scope": { getOfficerScope: async () => ({ all: true, ids: [] }), assertOfficerInScope: async () => {} },
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
  maxExtensionDays: 15, maxExtensionAttempts: 2, prePlacementMaxDays: 30,
  requirementType: "NONE", valueMode: null, combinedRequiredValue: null, requirementProducts: [],
  options: [{ valueWithoutGST: 80000, valueWithGST: 100000, bookingAmount: 25000, isActive: true }, { valueWithoutGST: 160000, valueWithGST: 200000, bookingAmount: 35000, isActive: true }],
};

async function main() {
  let written: Record<string, unknown> = {};
  const optionWrites: Record<string, unknown>[] = [];
  const tx = {
    scheme: { update: async ({ data }: { data: Record<string, unknown> }) => { written = data; } },
    schemeOption: { findMany: async () => [], create: async ({ data }: { data: Record<string, unknown> }) => { optionWrites.push(data); } },
  };
  const master = loadService<typeof import("./scheme-master.server")>("scheme-master.server.ts", {
    scheme: { create: async ({ data }: { data: Record<string, unknown> }) => { written = data; return { id: "scheme", schemeName: "Booking" }; },
      findUnique: async () => ({ structure: "MULTIPLE_OPTIONS", _count: { dealerPlans: 1 } }), updateMany: async () => {} },
    $transaction: async (fn: (db: typeof tx) => Promise<void>) => fn(tx),
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
  await assert.rejects(master.createScheme(ctx, { ...amountMode, installmentBalance: false }), /requires the final installment to be Balance/);
  await assert.rejects(master.createScheme(ctx, { ...amountMode, installments: [{ ...rule(1, 30000), calculationType: "FIXED_AMOUNT" }, { ...rule(2, 70000), calculationType: "FIXED_AMOUNT" }] }), /must be Balance/);
  await assert.rejects(master.createScheme(ctx, { ...amountMode, installments: [{ ...rule(1, 90000), calculationType: "FIXED_AMOUNT" }, { ...rule(2, 0), calculationType: "FIXED_AMOUNT" }] }), /final installment/);
  await assert.rejects(master.createScheme(ctx, { ...base, options: [{ ...base.options[0], bookingAmount: 75000 }] }));
  await assert.rejects(master.createScheme(ctx, { ...base, options: [{ ...base.options[0], bookingAmount: -1 }] }));
  // Fixed Amount still passes when all mandatory fields are present.
  const fixed = { ...base, structure: "FIXED", optionAchievementType: null, eligibleProductIds: [], options: [], installmentBalance: false,
    schemeValueWithoutGST: 80000, schemeValueWithGST: 100000, bookingAmount: 25000,
    requirementType: "PRODUCT_BASED", requirementProducts: [{ productId: "product", requiredQty: 1, requiredValue: null }] };
  await master.createScheme(ctx, { ...fixed, installments: [{ ...rule(1, 100000), calculationType: "FIXED_AMOUNT" }] });
  await assert.rejects(master.createScheme(ctx, { ...fixed, installments: [] }), /installment/i);
  await assert.rejects(master.createScheme(ctx, { ...fixed, schemeValueWithGST: 79999 }), /With GST/i);
  await assert.rejects(master.createScheme(ctx, { ...fixed, otherBenefitDetails: "" }), /Other Benefit Details/i);
  await assert.rejects(master.createScheme(ctx, { ...fixed, requirementType: "NONE", requirementProducts: [] }), /Scheme Basis/i);
  await assert.rejects(master.createScheme(ctx, { ...base, options: [{ ...base.options[0], valueWithGST: 79999 }] }), /With GST/i);
  await assert.rejects(master.createScheme(ctx, { ...base, options: [{ ...base.options[0], bookingAmount: null }] }), /Booking Amount/i);
  console.log("PASS master create/edit persists and validates Options Amount, mandatory fields, and GST values");

  let conversionTransactions = 0;
  const bills = loadService<typeof import("./scheme-bills.server")>("scheme-bills.server.ts", {
    dealerSchemePlan: { findUnique: async () => ({
      salesOfficerId: "admin", numberOfSchemes: 4, totalSchemeAmount: 400000,
      optionValueWithoutGST: null, optionValueWithGST: null, optionBookingAmount: null,
      scheme: { structure: "FIXED", schemeValueWithoutGST: 80000, schemeValueWithGST: 100000, bookingAmount: 0, installmentRules: [] },
    }) },
    $transaction: async () => { conversionTransactions++; return { ok: true }; },
  });
  const conversionBilling = (amountWithoutGST: string, amountWithGST: string) => ({
    billCount: 1, amountWithoutGST, amountWithGST,
    bills: [{ partNumber: 1, soBillDate: "2026-09-20", amountWithoutGST, amountWithGST }],
  });
  await assert.rejects(bills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, conversionBilling("319999.99", "400000")), /Without GST.*₹3,20,000/);
  await assert.rejects(bills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, conversionBilling("320000", "399999.99")), /With GST.*₹4,00,000/);
  assert.equal(conversionTransactions, 0);
  await bills.saveBillConversion(ctx, "plan", { schemeStatus: "CONVERTED" }, conversionBilling("320000", "400000"));
  assert.equal(conversionTransactions, 1);
  console.log("PASS SO conversion enforces combined preset minimums before its transaction");

  let saved: Record<string, unknown> = {};
  let currentState = "DRAFT";
  const option = { id: "option", label: "Legacy label", targetValue: 100000, targetQty: null, valueWithoutGST: 80000, valueWithGST: 100000, bookingAmount: 25000, isActive: true };
  const planService = loadService<typeof import("./scheme-planning.server")>("scheme-planning.server.ts", {
    scheme: { findUnique: async () => ({ status: "OPEN", isPerpetual: true, startDate: null, endDate: null, allowMultipleSchemes: false,
      schemeValueWithGST: null, structure: "MULTIPLE_OPTIONS", bookingAmount: 999, installmentBalance: true, prePlacementMaxDays: 0, states: [], options: [option] }) },
    dealerAssignment: { findMany: async () => [{ dealerId: "dealer" }] },
    dealerSchemePlan: {
      findMany: async () => [{ id: "plan", dealerId: "dealer", planStatus: currentState }],
      findUnique: async () => null, // instance expansion is unrelated to this snapshot test
      update: async ({ data }: { data: Record<string, unknown> }) => { saved = data; },
    },
  });
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
