/** Database-free transaction contract tests for the bulk Scheme Planning draft/submit save. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { AuthContext } from "@/lib/http";

const localRequire = createRequire(import.meta.url);
type Loaded = typeof import("./scheme-planning.server");

type Plan = {
  id: string;
  schemeId: string;
  dealerId: string;
  salesOfficerId: string;
  planStatus: string;
  planningStatus: string;
  segmentNumber: number;
  numberOfSchemes: number;
  totalSchemeAmount: number;
  selectedOptionId: string | null;
  installmentBalance: boolean;
  enrollmentStatus: string;
  expectedBillingDate?: Date | null;
  quantitySplitAsFuture: null;
  [key: string]: unknown;
};
type Instance = {
  id: string;
  dealerSchemePlanId: string;
  instanceNumber: number;
  soBillingDate: Date | null;
  adminBillingDate: Date | null;
  installments?: number;
};
type State = { plans: Plan[]; instances: Instance[]; audits: Record<string, unknown>[] };
type Failures = { planCreateDealer?: string; instanceCreatePlan?: string; audit?: boolean };
type QueryCounts = {
  planFindMany: number;
  planCreateMany: number;
  planUpdate: number;
  planDeleteMany: number;
  instanceFindMany: number;
  instanceCreateMany: number;
  instanceDeleteMany: number;
  auditCreate: number;
};

const clone = <T>(value: T): T => structuredClone(value);

function planRow(data: Record<string, unknown>, id: string): Plan {
  return {
    id,
    schemeId: String(data.schemeId),
    dealerId: String(data.dealerId),
    salesOfficerId: String(data.salesOfficerId),
    planStatus: String(data.planStatus ?? "DRAFT"),
    planningStatus: String(data.planningStatus ?? "DRAFT"),
    segmentNumber: Number(data.segmentNumber ?? 1),
    numberOfSchemes: Number(data.numberOfSchemes ?? 1),
    totalSchemeAmount: Number(data.totalSchemeAmount ?? 0),
    selectedOptionId: (data.selectedOptionId as string | null | undefined) ?? null,
    installmentBalance: Boolean(data.installmentBalance),
    enrollmentStatus: String(data.enrollmentStatus ?? "PENDING_DOCUMENT"),
    quantitySplitAsFuture: null,
    ...data,
  };
}

function harness(initial: State = { plans: [], instances: [], audits: [] }, failures: Failures = {}) {
  let committed = clone(initial);
  let nextPlan = 1;
  let nextInstance = 1;
  let transactionTimeout: number | undefined;
  const counts: QueryCounts = {
    planFindMany: 0, planCreateMany: 0, planUpdate: 0, planDeleteMany: 0,
    instanceFindMany: 0, instanceCreateMany: 0, instanceDeleteMany: 0, auditCreate: 0,
  };

  const client = (working: State) => ({
    dealerSchemePlan: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        counts.planFindMany++;
        if (where.schemeId) return working.plans.filter((p) => p.schemeId === where.schemeId && p.salesOfficerId === where.salesOfficerId).map(clone);
        const ids = new Set((where.id as { in: string[] }).in);
        return working.plans.filter((p) => ids.has(p.id) && p.enrollmentStatus !== "ENROLLED").map(clone);
      },
      createManyAndReturn: async ({ data }: { data: Record<string, unknown>[] }) => {
        counts.planCreateMany++;
        const rows: Plan[] = [];
        for (const dataRow of data) {
          if (failures.planCreateDealer === dataRow.dealerId) throw new Error("injected dealer plan failure");
          const row = planRow(dataRow, `plan-${nextPlan++}`);
          rows.push(row);
          working.plans.push(row);
        }
        return rows.map((row) => ({ id: row.id }));
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        counts.planUpdate++;
        const index = working.plans.findIndex((p) => p.id === where.id);
        if (index < 0) throw new Error("plan not found");
        working.plans[index] = { ...working.plans[index], ...data };
        return working.plans[index];
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        counts.planDeleteMany++;
        const ids = new Set(where.id.in);
        const before = working.plans.length;
        working.plans = working.plans.filter((p) => !ids.has(p.id));
        working.instances = working.instances.filter((i) => !ids.has(i.dealerSchemePlanId));
        return { count: before - working.plans.length };
      },
    },
    dealerSchemeInstance: {
      findMany: async ({ where }: { where: { dealerSchemePlanId: { in: string[] } } }) => {
        counts.instanceFindMany++;
        const planIds = new Set(where.dealerSchemePlanId.in);
        return working.instances
          .filter((i) => planIds.has(i.dealerSchemePlanId))
          .sort((a, b) => a.instanceNumber - b.instanceNumber)
          .map((i) => ({ ...clone(i), _count: { installments: i.installments ?? 0 } }));
      },
      createMany: async ({ data }: { data: { dealerSchemePlanId: string; instanceNumber: number }[] }) => {
        counts.instanceCreateMany++;
        if (data.some((row) => failures.instanceCreatePlan === row.dealerSchemePlanId)) throw new Error("injected child instance failure");
        const rows: Instance[] = data.map((row) => ({ id: `instance-${nextInstance++}`, ...row, soBillingDate: null, adminBillingDate: null }));
        working.instances.push(...rows);
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        counts.instanceDeleteMany++;
        const ids = new Set(where.id.in);
        working.instances = working.instances.filter((i) => !ids.has(i.id));
        return { count: ids.size };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        counts.auditCreate++;
        if (failures.audit) throw new Error("injected audit failure");
        working.audits.push(clone(data));
        return data;
      },
    },
  });

  const prisma = {
    scheme: { findUnique: async () => ({
      status: "OPEN", isPerpetual: true, startDate: null, endDate: null, allowMultipleSchemes: true,
      schemeValueWithGST: 100000, bookingAmount: 10000, installmentBalance: true, structure: "FIXED",
      prePlacementMaxDays: 0, states: [{ groupId: "state" }], options: [],
    }) },
    dealerAssignment: { findMany: async () => ["A", "B", "C", "OLD", ...Array.from({ length: 100 }, (_, index) => `D${index + 1}`)].map((dealerId) => ({ dealerId })) },
    // Any plan/instance mutation through the outer client is a transaction leak and must fail the test.
    dealerSchemePlan: new Proxy({}, { get: () => { throw new Error("outer dealerSchemePlan client used"); } }),
    dealerSchemeInstance: new Proxy({}, { get: () => { throw new Error("outer dealerSchemeInstance client used"); } }),
    $transaction: async (fn: (tx: ReturnType<typeof client>) => Promise<unknown>, options?: { timeout?: number }) => {
      transactionTimeout = options?.timeout;
      const working = clone(committed);
      try {
        const result = await fn(client(working));
        committed = working;
        return result;
      } catch (error) {
        throw error;
      }
    },
  };

  const filename = resolve("src/features/schemes/scheme-planning.server.ts");
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
    "@/lib/audit": { writeAudit: async (data: Record<string, unknown>, tx: ReturnType<typeof client>) => tx.auditLog.create({ data }) },
    "@/lib/http": { ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } },
    "@/lib/scope": { getOfficerScope: async () => ({ all: true, ids: [] }), assertOfficerInScope: async () => {}, getCurrentManagerId: async () => null },
  };
  runInNewContext(code, {
    exports, Date, console,
    require: (id: string) => id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id),
  }, { filename });

  return { service: exports as Loaded, state: () => clone(committed), counts, timeout: () => transactionTimeout };
}

const ctx = { userId: "officer", role: "SALES_OFFICER", groupId: "state" } as AuthContext;
const payload = (...dealers: { dealerId: string; numberOfSchemes?: number; expectedBillingDate?: string }[]) => ({ schemeId: "scheme", dealers });
const existingPlan = (overrides: Partial<Plan> = {}): Plan => planRow({
  schemeId: "scheme", dealerId: "A", salesOfficerId: "officer", planStatus: "DRAFT", planningStatus: "DRAFT",
  segmentNumber: 1, numberOfSchemes: 1, totalSchemeAmount: 100000, selectedOptionId: null,
  installmentBalance: false, enrollmentStatus: "PENDING_DOCUMENT", quantitySplitAsFuture: null,
  expectedBillingDate: new Date("2026-09-01T00:00:00.000Z"), ...overrides,
}, String(overrides.id ?? "existing-A"));

async function main() {
  {
    const h = harness();
    assert.equal(JSON.stringify(await h.service.saveSchemeDraft(ctx, payload({ dealerId: "A", numberOfSchemes: 2 }))), JSON.stringify({ drafted: 1, submitted: 0 }));
    assert.equal(h.state().plans.length, 1);
    assert.equal(h.state().instances.length, 2);
  }
  console.log("PASS atomic save commits one dealer and all of its instances");

  {
    const h = harness();
    assert.equal(JSON.stringify(await h.service.saveSchemeDraft(ctx, payload({ dealerId: "A" }, { dealerId: "B", numberOfSchemes: 2 }))), JSON.stringify({ drafted: 2, submitted: 0 }));
    assert.deepEqual(h.state().plans.map((p) => p.dealerId), ["A", "B"]);
    assert.equal(h.state().instances.length, 3);
  }
  console.log("PASS atomic save commits the complete multi-dealer request");

  {
    const h = harness(undefined, { planCreateDealer: "C" });
    await assert.rejects(h.service.saveSchemeDraft(ctx, payload({ dealerId: "A" }, { dealerId: "B" }, { dealerId: "C" })), /injected dealer plan failure/);
    assert.deepEqual(h.state(), { plans: [], instances: [], audits: [] });
  }
  console.log("PASS a middle dealer failure rolls back earlier dealer writes");

  {
    const h = harness(undefined, { instanceCreatePlan: "plan-1" });
    await assert.rejects(h.service.saveSchemeDraft(ctx, payload({ dealerId: "A", numberOfSchemes: 2 })), /injected child instance failure/);
    assert.deepEqual(h.state(), { plans: [], instances: [], audits: [] });
  }
  console.log("PASS a child instance failure rolls back its parent plan");

  {
    const original = existingPlan();
    const initial = { plans: [original], instances: [], audits: [] };
    const h = harness(initial, { instanceCreatePlan: "existing-A" });
    await assert.rejects(h.service.saveSchemeDraft(ctx, payload(
      { dealerId: "A", numberOfSchemes: 2, expectedBillingDate: "2026-10-01" },
      { dealerId: "C" },
    )), /injected child instance failure/);
    assert.deepEqual(h.state(), initial);
  }
  console.log("PASS a later failure restores an earlier existing-plan update");

  {
    const original = existingPlan({ id: "old-plan", dealerId: "OLD" });
    const initial = {
      plans: [original],
      instances: [{ id: "old-instance", dealerSchemePlanId: "old-plan", instanceNumber: 1, soBillingDate: null, adminBillingDate: null }],
      audits: [],
    };
    const h = harness(initial, { instanceCreatePlan: "plan-1" });
    await assert.rejects(h.service.saveSchemeDraft(ctx, payload({ dealerId: "A" })), /injected child instance failure/);
    assert.deepEqual(h.state(), initial);
  }
  console.log("PASS a failure after omitted-row deletion restores the original plan and child data");

  {
    const h = harness(undefined, { audit: true });
    await assert.rejects(h.service.saveSchemeDraft(ctx, payload({ dealerId: "A" })), /injected audit failure/);
    assert.deepEqual(h.state(), { plans: [], instances: [], audits: [] });
  }
  console.log("PASS audit failure rolls back the plan and instances in the same transaction");

  {
    const original = existingPlan({ numberOfSchemes: 1 });
    const initial = {
      plans: [original],
      instances: [{ id: "existing-1", dealerSchemePlanId: "existing-A", instanceNumber: 1, soBillingDate: null, adminBillingDate: null }],
      audits: [],
    };
    const h = harness(initial);
    await h.service.saveSchemeDraft(ctx, payload({ dealerId: "A", numberOfSchemes: 4 }));
    assert.deepEqual(h.state().instances.map((instance) => instance.instanceNumber), [1, 2, 3, 4]);
    assert.equal(h.counts.instanceCreateMany, 1);
  }
  console.log("PASS existing plans create only missing instance numbers in one bulk write");

  {
    const original = existingPlan({ numberOfSchemes: 5 });
    const initial: State = {
      plans: [original],
      instances: [
        { id: "instance-1", dealerSchemePlanId: "existing-A", instanceNumber: 1, soBillingDate: null, adminBillingDate: null },
        { id: "instance-2", dealerSchemePlanId: "existing-A", instanceNumber: 2, soBillingDate: null, adminBillingDate: null },
        { id: "instance-3", dealerSchemePlanId: "existing-A", instanceNumber: 3, soBillingDate: new Date("2026-09-01"), adminBillingDate: null },
        { id: "instance-4", dealerSchemePlanId: "existing-A", instanceNumber: 4, soBillingDate: null, adminBillingDate: null, installments: 1 },
        { id: "instance-5", dealerSchemePlanId: "existing-A", instanceNumber: 5, soBillingDate: null, adminBillingDate: null },
      ],
      audits: [],
    };
    const h = harness(initial);
    await h.service.saveSchemeDraft(ctx, payload({ dealerId: "A", numberOfSchemes: 2 }));
    assert.deepEqual(h.state().instances.map((instance) => instance.instanceNumber), [1, 2, 3, 4]);
    assert.equal(h.counts.instanceDeleteMany, 1);
  }
  console.log("PASS bulk pruning deletes only surplus empty instances and preserves protected history");

  {
    const h = harness();
    const dealers = Array.from({ length: 100 }, (_, index) => ({ dealerId: `D${index + 1}`, numberOfSchemes: 10 }));
    const result = await h.service.saveSchemeDraft(ctx, payload(...dealers));
    assert.equal(JSON.stringify(result), JSON.stringify({ drafted: 100, submitted: 0 }));
    assert.equal(h.state().plans.length, 100);
    assert.equal(h.state().instances.length, 1000);
    assert.equal(h.counts.planCreateMany, 1);
    assert.equal(h.counts.planFindMany, 2);
    assert.equal(h.counts.instanceFindMany, 1);
    assert.equal(h.counts.instanceCreateMany, 1);
    assert.equal(h.counts.planUpdate, 0);
    assert.equal(h.timeout(), 15000);
  }
  console.log("PASS 100 dealers × 10 instances complete with five plan/instance round trips and a scoped 15s timeout");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
