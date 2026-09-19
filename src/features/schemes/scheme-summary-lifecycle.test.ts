/**
 * Regression tests for the Scheme-wise summary lifecycle split + per-tab Total Amount (`schemeWiseSummary`).
 *   npx tsx src/features/schemes/scheme-summary-lifecycle.test.ts
 *
 * Submitted vs Approved is driven by PLAN STATUS (PENDING_RM / PENDING_APPROVAL = Submitted; APPROVED =
 * Approved) via the shared `planLifecycle`, so the parent aggregation and the expanded rows use the same
 * dataset. A converted-but-still-Pending plan stays in Submitted; an Approved plan stays in Approved even when
 * its Scheme Status is Converted. Total Amount is per-tab: Submitted = planned amount; Approved = admin-final
 * confirmed amount. Split/cancel are segment-safe (Future Draft is DRAFT → excluded; cancelled never stored).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { AuthContext } from "@/lib/http";

const localRequire = createRequire(import.meta.url);
function loadService<T>(name: string, prisma: object): T {
  const filename = resolve("src/features/schemes", name);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    "server-only": {},
    "./scheme-bills.server": { saveBillConversion: async () => {}, verifyBills: async () => {}, rejectLegacyBillWrite: async () => {} },
    "./scheme-plan-quantity.server": { applyConversionQuantity: async () => ({ split: false }) },
    "./scheme-bill-product.server": { productBillingForPlans: async () => new Map() },
    "./scheme-master.server": { refreshSchemeStatuses: async () => {} },
    "@/lib/prisma": { prisma },
    "@/lib/audit": { writeAudit: async () => {} },
    "@/lib/http": { ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } },
    "@/lib/scope": { getOfficerScope: async () => ({ all: true, ids: [] }), assertOfficerInScope: async () => {} },
  };
  runInNewContext(code, { exports, Date, console, require: (id: string) => id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id) }, { filename });
  return exports as T;
}

const ctx = { userId: "admin", role: "SUPER_ADMIN", groupId: null } as AuthContext;
const assignments = ["S1", "S2", "S3", "A1", "A2"].map((dealerId) => ({ officerId: "so1", dealerId }));

const mkRow = (over: Record<string, unknown>) => ({
  billMode: false, adminAmountWithGST: null, soBillCount: null, adminBillCount: null, bills: [],
  schemeId: "fasal", dealerId: "S1", salesOfficerId: "so1", numberOfSchemes: 1,
  planStatus: "APPROVED", schemeStatus: "PENDING", adminVerifiedAt: null, adminBookingStatus: null, adminDocumentStatus: null,
  billingDate: null, adminBillingDate: null, totalSchemeAmount: 585000,
  scheme: { schemeName: "Fasal Vriddhi", schemeValueWithGST: 780000, status: "OPEN" },
  salesOfficer: { name: "Subham Yadav", group: { name: "MP" } },
  instances: [],
  ...over,
});

// SUBMITTED (pending plan status) — SUB2 is Converted but still Pending Approval (Example 2).
const SUB_PENDING = mkRow({ dealerId: "S1", planStatus: "PENDING_APPROVAL", schemeStatus: "PENDING", numberOfSchemes: 3, totalSchemeAmount: 2340000 });
const SUB_CONVERTED = mkRow({ dealerId: "S2", planStatus: "PENDING_APPROVAL", schemeStatus: "CONVERTED", numberOfSchemes: 1, totalSchemeAmount: 585000 });
const SUB_RM = mkRow({ dealerId: "S3", planStatus: "PENDING_RM", schemeStatus: "PENDING", numberOfSchemes: 1, totalSchemeAmount: 585000 });
// APPROVED (Example 3 pending conversion; Example 4 converted + admin-final green).
const APP_PENDING = mkRow({ dealerId: "A1", planStatus: "APPROVED", schemeStatus: "PENDING", numberOfSchemes: 2, totalSchemeAmount: 1000000 });
const APP_GREEN = mkRow({ dealerId: "A2", planStatus: "APPROVED", schemeStatus: "CONVERTED", adminVerifiedAt: new Date(), adminBookingStatus: "RECEIVED", adminDocumentStatus: "RECEIVED_SOFT", numberOfSchemes: 2, totalSchemeAmount: 1560000 });
// FUTURE_DRAFT quantity segment for S1 — DRAFT, must be excluded from Submitted.
const FUTURE_DRAFT = mkRow({ dealerId: "S1", planStatus: "DRAFT", schemeStatus: "PENDING", numberOfSchemes: 2, totalSchemeAmount: 200000 });

const prismaMock = (rows: unknown[]) => ({
  dealerSchemePlan: { findMany: async () => rows },
  dealerAssignment: { findMany: async () => assignments },
  user: { findMany: async () => [] },
});
type Summary = typeof import("./scheme-planning.server");
const fasal = (p: Awaited<ReturnType<Summary["schemeWiseSummary"]>>) => p.rows.find((x) => x.schemeId === "fasal")!;
const ALL = [SUB_PENDING, SUB_CONVERTED, SUB_RM, APP_PENDING, APP_GREEN];

let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); passed += 1; console.log(`  ok  ${name}`); }

async function main() {
  await test("1/4. Pending plan statuses (incl. Pending+Converted) → Submitted; Approved excluded", async () => {
    const r = fasal(await loadService<Summary>("scheme-planning.server.ts", prismaMock(ALL)).schemeWiseSummary(ctx, { lifecycle: "SUBMITTED" }));
    assert.equal(r.plannedDealers, 3, "S1 + S2 + S3 (Approved A1/A2 excluded)");
    assert.equal(r.plannedSchemes, 5, "3 + 1 + 1");
    assert.equal(r.totalAmount, 3510000, "planned total of the three Submitted plans (2,340,000 + 585,000 + 585,000)");
    assert.equal(r.adminConvertedDealers, 0, "no admin-final conversions in Submitted");
  });

  await test("2/3. Approved plan statuses (pending OR converted Scheme Status) → Approved", async () => {
    const r = fasal(await loadService<Summary>("scheme-planning.server.ts", prismaMock(ALL)).schemeWiseSummary(ctx, { lifecycle: "APPROVED" }));
    assert.equal(r.plannedDealers, 2, "A1 (Scheme PENDING) + A2 (Scheme CONVERTED)");
    assert.equal(r.plannedSchemes, 4, "2 + 2");
    assert.equal(r.adminConvertedDealers, 1, "only A2 is admin-final converted");
    assert.equal(r.totalAmount, 1560000, "Approved Total = admin-final confirmed (A2); A1 pending contributes 0");
  });

  await test("5. Approved plans are NOT present in Submitted", async () => {
    const r = fasal(await loadService<Summary>("scheme-planning.server.ts", prismaMock([APP_PENDING, APP_GREEN])).schemeWiseSummary(ctx, { lifecycle: "SUBMITTED" }));
    assert.equal(r?.plannedDealers ?? 0, 0, "no Approved plan leaks into Submitted");
  });

  await test("6. Parent aggregation uses the SAME plan-status filter as the classifier (consistent dataset)", async () => {
    const sub = fasal(await loadService<Summary>("scheme-planning.server.ts", prismaMock(ALL)).schemeWiseSummary(ctx, { lifecycle: "SUBMITTED" }));
    const app = fasal(await loadService<Summary>("scheme-planning.server.ts", prismaMock(ALL)).schemeWiseSummary(ctx, { lifecycle: "APPROVED" }));
    assert.equal(sub.plannedDealers + app.plannedDealers, 5, "every non-editable plan lands in exactly one tab (3 + 2)");
  });

  await test("9/10. FUTURE_DRAFT segment is excluded from Submitted; dealer counts stay distinct", async () => {
    const r = fasal(await loadService<Summary>("scheme-planning.server.ts", prismaMock([SUB_PENDING, FUTURE_DRAFT])).schemeWiseSummary(ctx, { lifecycle: "SUBMITTED" }));
    assert.equal(r.plannedDealers, 1, "same dealer S1, counted once");
    assert.equal(r.plannedSchemes, 3, "only the Submitted segment (Draft excluded)");
    assert.equal(r.totalAmount, 2340000, "Draft remainder amount not added");
  });

  console.log(`\n${passed} scheme-summary lifecycle/amount tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
