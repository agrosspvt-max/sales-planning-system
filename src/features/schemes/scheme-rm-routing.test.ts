/**
 * RM-routing regression tests for Scheme Planning submission (`submitSchemePlan` + bulk `persistDraft`).
 *   npx tsx src/features/schemes/scheme-rm-routing.test.ts
 *
 * GLOBAL RULE (see also Seasonal/Yearly/Monthly/Recovery, which already implement it):
 *   SO submits + owner HAS an active RM  → PENDING_RM        (RM approval required)
 *   SO submits + owner has NO active RM  → PENDING_APPROVAL  (straight to Admin; never stuck at Pending-RM)
 *   RM submits their OWN plan            → PENDING_APPROVAL  (RM is the approver; skips RM review)
 * Authority is the existing group-based `getCurrentManagerId(ownerId)` (null = no applicable RM).
 * Legacy `planningStatus` is dual-written: to-RM → SUBMITTED; skip-RM → RM_APPROVED (existing convention).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { AuthContext } from "@/lib/http";

const localRequire = createRequire(import.meta.url);

type Loaded = typeof import("./scheme-planning.server");
type Captured = { planStatus?: string; planningStatus?: string; rmActedById?: string | null };

/**
 * Load scheme-planning.server.ts with a mocked prisma + scope. `managerFor` decides what
 * getCurrentManagerId returns per owner id (null ⇒ no RM). `captured` records the update() payload.
 */
function loadScheme(managerFor: (officerId: string) => string | null, rows: {
  plan?: Record<string, unknown>;
  assignments?: { dealerId: string }[];
  scheme?: Record<string, unknown>;
}, captured: Captured): Loaded {
  const filename = resolve("src/features/schemes", "scheme-planning.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const record = (data: Record<string, unknown>) => {
    if ("planStatus" in data) captured.planStatus = data.planStatus as string;
    if ("planningStatus" in data) captured.planningStatus = data.planningStatus as string;
    if ("rmActedById" in data) captured.rmActedById = (data.rmActedById as string | null) ?? null;
    return { id: "p1" };
  };
  const prisma = {
    dealerSchemePlan: {
      findUnique: async () => rows.plan ?? null,
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => record(data),
      update: async ({ data }: { data: Record<string, unknown> }) => record(data),
    },
    dealerAssignment: { findFirst: async () => ({ id: "a1" }), findMany: async () => rows.assignments ?? [] },
    scheme: { findUnique: async () => rows.scheme ?? null },
    user: { findMany: async () => [] },
  };
  const exports = {};
  const mocks: Record<string, unknown> = {
    "server-only": {},
    "./scheme-bills.server": { saveBillConversion: async () => {}, verifyBills: async () => {}, rejectLegacyBillWrite: async () => {} },
    "./scheme-plan-quantity.server": { applyConversionQuantity: async () => ({ split: false }) },
    "./scheme-master.server": { refreshSchemeStatuses: async () => {} },
    "@/lib/prisma": { prisma },
    "@/lib/audit": { writeAudit: async () => {} },
    "@/lib/http": { ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } },
    "@/lib/scope": {
      getOfficerScope: async () => ({ all: true, ids: [] }),
      assertOfficerInScope: async () => {},
      getCurrentManagerId: async (officerId: string) => managerFor(officerId),
    },
  };
  runInNewContext(code, { exports, Date, console, require: (id: string) => id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id) }, { filename });
  return exports as Loaded;
}

const soCtx = { userId: "so1", role: "SALES_OFFICER", groupId: "g1" } as AuthContext;
const rmCtx = { userId: "rm1", role: "REGIONAL_MANAGER", groupId: "g1" } as AuthContext;

let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); passed += 1; console.log(`  ok  ${name}`); }

async function main() {
  /* ------- submitSchemePlan (single-plan submit) ------- */
  await test("A. SO submits + owner HAS an RM → PENDING_RM (legacy SUBMITTED, no rmActedBy)", async () => {
    const cap: Captured = {};
    const svc = loadScheme((id) => (id === "so1" ? "rm1" : null), { plan: { salesOfficerId: "so1", planStatus: "DRAFT" } }, cap);
    const r = await svc.submitSchemePlan(soCtx, "p1");
    assert.equal(r.planStatus, "PENDING_RM");
    assert.equal(cap.planStatus, "PENDING_RM");
    assert.equal(cap.planningStatus, "SUBMITTED", "legacy dual-write for the to-RM path");
    assert.equal(cap.rmActedById, null, "no RM has acted yet");
  });

  await test("B. SO submits + owner has NO RM → PENDING_APPROVAL (legacy RM_APPROVED, skips RM)", async () => {
    const cap: Captured = {};
    const svc = loadScheme(() => null, { plan: { salesOfficerId: "so1", planStatus: "DRAFT" } }, cap);
    const r = await svc.submitSchemePlan(soCtx, "p1");
    assert.equal(r.planStatus, "PENDING_APPROVAL", "no RM in the group → straight to Admin");
    assert.equal(cap.planStatus, "PENDING_APPROVAL");
    assert.equal(cap.planningStatus, "RM_APPROVED", "legacy skip-RM convention");
    assert.equal(cap.rmActedById, null);
  });

  await test("C. RM submits their OWN plan → PENDING_APPROVAL (skip RM), unchanged behaviour", async () => {
    const cap: Captured = {};
    // Even if getCurrentManagerId(owner) were non-null, the RM-self short-circuit must skip RM.
    const svc = loadScheme(() => "someone", { plan: { salesOfficerId: "rm1", planStatus: "DRAFT" } }, cap);
    const r = await svc.submitSchemePlan(rmCtx, "p1");
    assert.equal(r.planStatus, "PENDING_APPROVAL");
    assert.equal(cap.planningStatus, "RM_APPROVED");
  });

  await test("D. Returned plan re-submitted by SO with no RM → PENDING_APPROVAL", async () => {
    const cap: Captured = {};
    const svc = loadScheme(() => null, { plan: { salesOfficerId: "so1", planStatus: "RETURNED" } }, cap);
    const r = await svc.submitSchemePlan(soCtx, "p1");
    assert.equal(r.planStatus, "PENDING_APPROVAL");
  });

  /* ------- persistDraft (bulk Create Plan submit) uses the SAME rule ------- */
  const openScheme = {
    status: "OPEN", isPerpetual: true, startDate: null, endDate: null, allowMultipleSchemes: false,
    schemeValueWithGST: 100000, bookingAmount: 0, installmentBalance: false, structure: "FIXED",
    prePlacementMaxDays: 0, states: [{ groupId: "g1" }], options: [],
  };
  const draftPayload = { schemeId: "sch1", dealers: [{ dealerId: "d1", expectedBillingDate: "2026-10-01" }], submitDealerIds: ["d1"] };

  await test("E. Bulk submit: SO owner HAS an RM → PENDING_RM", async () => {
    const cap: Captured = {};
    const svc = loadScheme((id) => (id === "so1" ? "rm1" : null), { scheme: openScheme, assignments: [{ dealerId: "d1" }] }, cap);
    await svc.submitSchemeDraft(soCtx, draftPayload);
    assert.equal(cap.planStatus, "PENDING_RM");
    assert.equal(cap.planningStatus, "SUBMITTED");
  });

  await test("F. Bulk submit: SO owner has NO RM → PENDING_APPROVAL (skip RM)", async () => {
    const cap: Captured = {};
    const svc = loadScheme(() => null, { scheme: openScheme, assignments: [{ dealerId: "d1" }] }, cap);
    await svc.submitSchemeDraft(soCtx, draftPayload);
    assert.equal(cap.planStatus, "PENDING_APPROVAL");
    assert.equal(cap.planningStatus, "RM_APPROVED");
  });

  console.log(`\n${passed} scheme RM-routing tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
