/** Database-free transaction contracts for the approved-plan quantity split service. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { AuthContext } from "@/lib/http";

const localRequire = createRequire(import.meta.url);
function loadService<T>(txAudit: (record: unknown) => void): T {
  const filename = resolve("src/features/schemes/scheme-plan-quantity.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    "server-only": {},
    "@/lib/audit": { writeAudit: async (record: unknown) => txAudit(record) },
    "@/lib/http": { ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } },
  };
  runInNewContext(code, {
    exports, Date, console,
    require: (id: string) => id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id),
  }, { filename });
  return exports as T;
}

type MutableState = {
  sourceQuantity: number;
  sourceTotal: number;
  future: null | { id: string; quantity: number; total: number; segmentNumber: number };
  instances: { id: string; planId: string; instanceNumber: number }[];
  split: null | Record<string, unknown>;
  audits: unknown[];
};

const ctx = { userId: "so", role: "SALES_OFFICER", groupId: null } as AuthContext;
const initialState = (): MutableState => ({
  sourceQuantity: 4,
  sourceTotal: 400000,
  future: null,
  instances: [1, 2, 3, 4].map((instanceNumber) => ({ id: `instance-${instanceNumber}`, planId: "source", instanceNumber })),
  split: null,
  audits: [],
});

function harness(opts: { prohibited?: boolean; failMove?: boolean } = {}) {
  let state = initialState();
  const calls = { aggregate: 0, instanceUpdateMany: 0, instanceCreateMany: 0 };
  const service = loadService<typeof import("./scheme-plan-quantity.server")>((record) => state.audits.push(record));
  const source = () => ({
    id: "source", schemeId: "scheme", dealerId: "dealer", salesOfficerId: "so", segmentNumber: 1,
    planningStatus: "RM_APPROVED", planStatus: "APPROVED", schemeStatus: "PENDING", enrollmentStatus: "PENDING_DOCUMENT",
    numberOfSchemes: state.sourceQuantity, totalSchemeAmount: state.sourceTotal,
    expectedBillingDate: new Date("2026-09-20"), originalConversionDate: new Date("2026-09-20"), submittedAt: new Date("2026-09-01"),
    soNote: "original", selectedOptionId: null, optionBookingAmount: null, installmentBalance: true,
    optionLabel: null, optionTargetQty: null, optionTargetValue: null, optionValueWithoutGST: null, optionValueWithGST: null,
    prePlacementDays: null, conversionDate: null, soBookingStatus: null, soBookingAmount: null, soDocumentStatus: null,
    adminConversionDate: null, adminBookingStatus: null, adminBookingAmount: null, adminDocumentStatus: null,
    adminBillingDate: null, adminVerifiedAt: null, enrolledAt: null, billMode: false, billsLockedAt: null,
    quantitySplitAsSource: state.split ? { id: "split" } : null,
    scheme: { structure: "FIXED", schemeValueWithGST: 100000 },
    instances: state.instances.filter((i) => i.planId === "source").map((i) => ({
      ...i, soBillingDate: null, adminBillingDate: null, billMode: false, billsLockedAt: null,
      _count: { bills: 0, installments: 0 },
    })),
    _count: { bills: 0, payments: opts.prohibited ? 1 : 0 },
  });
  const tx = {
    $queryRaw: async () => [{ id: "source" }],
    dealerSchemePlan: {
      findUnique: async () => source(),
      aggregate: async () => { calls.aggregate++; return { _max: { segmentNumber: 1 } }; },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.future = { id: "future", quantity: data.numberOfSchemes as number, total: Number(data.totalSchemeAmount), segmentNumber: data.segmentNumber as number };
        return { id: "future" };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        state.sourceQuantity = data.numberOfSchemes as number;
        state.sourceTotal = Number(data.totalSchemeAmount);
      },
    },
    dealerSchemeInstance: {
      updateMany: async ({ where, data }: { where: { id: { in: string[] }; dealerSchemePlanId: string }; data: { dealerSchemePlanId: string; instanceNumber: { decrement: number } } }) => {
        calls.instanceUpdateMany++;
        if (opts.failMove) throw new Error("simulated instance move failure");
        const instances = state.instances.filter((i) => where.id.in.includes(i.id) && i.planId === where.dealerSchemePlanId);
        for (const instance of instances) {
          instance.planId = data.dealerSchemePlanId;
          instance.instanceNumber -= data.instanceNumber.decrement;
        }
        return { count: instances.length };
      },
      createMany: async ({ data }: { data: { dealerSchemePlanId: string; instanceNumber: number }[] }) => {
        calls.instanceCreateMany++;
        for (const row of data) state.instances.push({ id: `created-${state.instances.length + 1}`, planId: row.dealerSchemePlanId, instanceNumber: row.instanceNumber });
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        state.instances = state.instances.filter((i) => !where.id.in.includes(i.id));
      },
    },
    schemePlanQuantitySplit: { create: async ({ data }: { data: Record<string, unknown> }) => { state.split = data; } },
  };
  const transaction = async <T>(run: (client: typeof tx) => Promise<T>) => {
    const before = structuredClone(state);
    try { return await run(tx); }
    catch (error) { state = before; throw error; }
  };
  return { service, tx, transaction, state: () => state, calls };
}

async function main() {
  {
    const h = harness();
    const result = await h.transaction((tx) => h.service.applyConversionQuantity(tx as never, ctx, "source", { proceedingSchemes: 4 }));
    assert.equal(result.split, false);
    assert.equal(h.state().future, null);
    assert.equal(h.state().sourceQuantity, 4);
  }
  {
    const h = harness();
    await h.transaction((tx) => h.service.applyConversionQuantity(tx as never, ctx, "source", { proceedingSchemes: 2, remainingDisposition: "FUTURE_DRAFT" }));
    assert.deepEqual(h.state().future, { id: "future", quantity: 2, total: 200000, segmentNumber: 2 });
    assert.equal(h.state().sourceQuantity, 2);
    assert.equal(h.state().sourceTotal, 200000);
    assert.deepEqual(h.state().instances.map((i) => [i.planId, i.instanceNumber]), [["source", 1], ["source", 2], ["future", 1], ["future", 2]]);
    assert.deepEqual(h.calls, { aggregate: 1, instanceUpdateMany: 1, instanceCreateMany: 0 });
    const split = h.state().split;
    assert.deepEqual(split && { originalQuantity: split.originalQuantity, proceedingQuantity: split.proceedingQuantity, remainingQuantity: split.remainingQuantity }, { originalQuantity: 4, proceedingQuantity: 2, remainingQuantity: 2 });
  }
  {
    const h = harness();
    await h.transaction((tx) => h.service.applyConversionQuantity(tx as never, ctx, "source", { proceedingSchemes: 2, remainingDisposition: "CANCELLED" }));
    assert.equal(h.state().future, null);
    assert.equal(h.state().sourceQuantity, 2);
    assert.deepEqual(h.state().instances.map((i) => i.instanceNumber), [1, 2]);
    assert.equal(h.state().split?.remainingQuantity, 2);
    assert.deepEqual(h.calls, { aggregate: 0, instanceUpdateMany: 0, instanceCreateMany: 0 });
  }
  {
    const h = harness();
    h.state().instances = h.state().instances.filter((i) => i.instanceNumber !== 2 && i.instanceNumber !== 4);
    await h.transaction((tx) => h.service.applyConversionQuantity(tx as never, ctx, "source", { proceedingSchemes: 2, remainingDisposition: "FUTURE_DRAFT" }));
    assert.deepEqual(h.state().instances.map((i) => [i.planId, i.instanceNumber]), [["source", 1], ["future", 1], ["future", 2], ["source", 2]]);
    assert.equal(h.calls.instanceCreateMany, 1);
  }
  {
    const h = harness({ prohibited: true });
    await assert.rejects(h.transaction((tx) => h.service.applyConversionQuantity(tx as never, ctx, "source", { proceedingSchemes: 2, remainingDisposition: "CANCELLED" })), /cannot be split after/);
    assert.deepEqual(h.state(), initialState());
  }
  {
    const h = harness({ failMove: true });
    await assert.rejects(h.transaction((tx) => h.service.applyConversionQuantity(tx as never, ctx, "source", { proceedingSchemes: 2, remainingDisposition: "FUTURE_DRAFT" })), /simulated instance move failure/);
    assert.deepEqual(h.state(), initialState());
  }
  console.log("6 quantity-split transaction contracts passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
