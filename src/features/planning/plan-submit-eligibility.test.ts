/**
 * Regression tests for the "inactive dealers block submission" bug, running the REAL submit functions
 * over a DB-free fake Prisma.
 *   npx tsx src/features/planning/plan-submit-eligibility.test.ts
 *
 * Root cause: each plan's VIEW/draft query lists only currently-plannable dealers
 * (Monthly/Seasonal: `dealer.isActive && status != DEFAULTER`; Recovery: `dealer.isActive`), but the
 * SUBMIT completion gate queried PlanDealer/RecoveryPlanDealer by plan id with NO dealer filter — so an
 * Inactive dealer that still has a historical plan row was counted as "must be planned" yet was hidden
 * from the UI, making submission impossible.
 *
 * The fake Prisma faithfully APPLIES the `where.dealer` relation filter, so if the fix were missing the
 * inactive dealer would reappear in the gate and these tests would fail.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";

const OFFICER = "officer-1";
const MONTH = "month-1";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const OWNER: AuthContext = { userId: OFFICER, role: Role.SALES_OFFICER, username: "so", groupId: "g1" } as AuthContext;
const OTHER: AuthContext = { userId: "someone-else", role: Role.SALES_OFFICER, username: "x", groupId: "g1" } as AuthContext;

// A plan-dealer fixture: dealer status + whether the officer planned a value for it.
interface Row {
  dealerId: string;
  name: string;
  isActive: boolean;
  status: string;
  planned: boolean;
  noPlan?: boolean;
}

/** Faithfully apply the Prisma `where.dealer` relation filter (isActive / status.not). */
function applyDealerFilter(rows: Row[], where: Record<string, unknown> | undefined): Row[] {
  const df = where?.dealer as { isActive?: boolean; status?: { not?: string } } | undefined;
  if (!df) return rows;
  return rows.filter((r) => {
    if (df.isActive !== undefined && r.isActive !== df.isActive) return false;
    if (df.status?.not !== undefined && r.status === df.status.not) return false;
    return true;
  });
}

const localRequire = createRequire(import.meta.url);
function transpile(relDir: string, file: string): string {
  const filename = resolve(relDir, file);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return code;
}
function run(code: string, filename: string, mocks: Record<string, unknown>): Record<string, unknown> {
  const exports = {};
  const req = (id: string) =>
    id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id);
  runInNewContext(code, { exports, console, Date, Math, JSON, require: req }, { filename });
  return exports;
}

const notifications = { createNotification: async () => {}, notifyMany: async () => {}, getSuperAdminIds: async () => [] };
const scopeBase = {
  assertOfficerInScope: async () => {},
  getCurrentManagerId: async () => null,
  getOfficerScope: async () => ({ all: true, ids: [] }),
  isDealerOwnerRole: () => true,
  isPlanOwner: (ctx: AuthContext, officerId: string) =>
    (ctx.role === Role.SALES_OFFICER || ctx.role === Role.REGIONAL_MANAGER) && officerId === ctx.userId,
};
const lifecycleStub = {
  assertLifecycleEditable: () => {},
  officerVisibilityWhere: () => ({}),
  isHiddenFromOfficer: () => false,
  isHiddenByArchivedParent: () => false,
};

/* --------------------------------- Monthly -------------------------------- */
function loadMonthly(rows: Row[], captured: { where?: Record<string, unknown> }) {
  const prisma = {
    monthlyPlan: {
      findUnique: async () => ({
        id: "mp1", officerId: OFFICER, seasonPlanId: "sp1", seasonMonthId: MONTH,
        status: "DRAFT", lifecycleState: "ACTIVE",
        seasonPlan: { seasonId: "sea1", officerId: OFFICER, lifecycleState: "ACTIVE" },
        seasonMonth: { name: "July", order: 1, calendarMonth: 7, calendarYear: 2026 },
      }),
      update: async () => ({}),
    },
    planDealer: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        captured.where = where;
        return applyDealerFilter(rows, where).map((r) => ({ dealerId: r.dealerId, dealer: { name: r.name }, _planned: r.planned }));
      },
    },
    monthlyPlanDealer: { findMany: async () => rows.filter((r) => r.noPlan).map((r) => ({ dealerId: r.dealerId })) },
    season: { findUnique: async () => ({ monthlyMode: "PACK_SIZE", name: "Kharif", year: 2026 }) },
    user: { findUnique: async () => ({ name: "Officer" }) },
    approvalAction: { create: async () => ({}) },
  };
  const mocks: Record<string, unknown> = {
    "server-only": {},
    "@/lib/season-calendar": { SEASON_MONTH_ORDER: [], calendarRows: () => [] },
    "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError },
    "@/lib/scope": scopeBase,
    "@/features/notifications/service.server": notifications,
    "@/lib/validations/planning": { saveMonthlySchema: {} },
    "@/lib/calc": { isQuantityMode: () => false },
    "@/lib/match-key": { tightKey: () => "" },
    "@/lib/dealer-resolver": { findProbableDealers: async () => [] },
    "@/lib/dealer-status": { DEALER_STATUSES: ["PENDING", "ACTIVE", "INACTIVE", "DEFAULTER"], isActiveForStatus: () => true },
    "@/features/users/catalogue.server": { planningProductsForOfficer: async () => [], catalogueEntryForOfficerProduct: () => null, clearanceMapForGroup: async () => new Map(), clearanceSoldForGroup: async () => new Map() },
    "@/lib/audit": { writeAudit: async () => {} },
    "@/features/assignments/service.server": { applyDealerAssignment: async () => {} },
    // Faithful stub of buildMonthlyDealers: one product carrying the planned value for THIS month.
    "./monthly.server": { buildMonthlyDealers: (planDealers: { dealerId: string; dealer: { name: string }; _planned: boolean }[]) => planDealers.map((pd) => ({ dealerId: pd.dealerId, dealerName: pd.dealer.name, products: [{ monthly: { [MONTH]: { plan: pd._planned ? 1 : 0 } } }] })) },
    "@/features/products/merge.server": { loadEffectiveProduct: async () => null },
    "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
    "./lifecycle.server": lifecycleStub,
  };
  return run(transpile("src/features/planning", "monthly-plan.server.ts"), resolve("src/features/planning", "monthly-plan.server.ts"), mocks) as {
    submitMonthlyPlan: (ctx: AuthContext, id: string) => Promise<{ status: string }>;
  };
}

/* --------------------------------- Seasonal ------------------------------- */
function loadSeasonal(rows: Row[], captured: { where?: Record<string, unknown> }) {
  const activeIds = rows.filter((r) => r.isActive && r.status !== "DEFAULTER").map((r) => r.dealerId);
  const prisma = {
    seasonPlan: {
      findUnique: async () => ({ id: "sp1", officerId: OFFICER, seasonId: "sea1", status: "DRAFT", lifecycleState: "ACTIVE" }),
      update: async () => ({}),
    },
    season: { findUnique: async () => ({ status: "OPEN", name: "Kharif", year: 2026 }) },
    planDealer: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        captured.where = where;
        return applyDealerFilter(rows, where).map((r) => ({
          dealerId: r.dealerId, noPlan: !!r.noPlan, dealer: { name: r.name },
          lines: [{ inputValue: r.planned ? 1 : 0, packs: [{ quantity: 0 }] }],
        }));
      },
    },
    user: { findUnique: async () => ({ name: "Officer" }) },
    approvalAction: { create: async () => ({}) },
  };
  const mocks: Record<string, unknown> = {
    "server-only": {},
    "@/lib/season-calendar": { SEASON_MONTH_ORDER: [], calendarRows: () => [] },
    "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError },
    "@/lib/scope": { ...scopeBase, getCurrentDealerIds: async () => activeIds },
    "@/features/users/catalogue.server": { planningProductsForOfficer: async () => [], clearanceMapForGroup: async () => new Map() },
    "@/features/products/merge.server": { loadEffectiveProduct: async () => null },
    "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
    "@/lib/validations/planning": { saveLinesSchema: {}, remarksSchema: {}, revisionRequestSchema: {} },
    "@/features/seasons/service.server": { findOrCreateSeason: async () => ({}) },
    "@/lib/audit": { writeAudit: async () => {} },
    "@/features/notifications/service.server": notifications,
    "@/lib/calc": { assembleWorkbookLine: () => ({}) },
    "./lifecycle.server": lifecycleStub,
  };
  return run(transpile("src/features/planning", "service.server.ts"), resolve("src/features/planning", "service.server.ts"), mocks) as {
    submitPlan: (ctx: AuthContext, id: string) => Promise<{ status: string }>;
  };
}

/* --------------------------------- Recovery ------------------------------- */
function loadRecovery(rows: Row[], captured: { where?: Record<string, unknown> }) {
  const prisma = {
    recoveryPlan: {
      findUnique: async () => ({
        id: "rp1", officerId: OFFICER, status: "DRAFT", lifecycleState: "ACTIVE",
        seasonMonth: { name: "July" }, season: { name: "Kharif", year: 2026 }, seasonPlan: null,
      }),
      update: async () => ({}),
    },
    recoveryPlanDealer: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        captured.where = where;
        return applyDealerFilter(rows, where).map((r) => ({
          noPlan: !!r.noPlan, monthRecoveryPlan: r.planned ? 1 : 0, monthRunningRecovery: 0, dealer: { name: r.name },
        }));
      },
    },
    user: { findUnique: async () => ({ name: "Officer" }) },
    approvalAction: { create: async () => ({}) },
  };
  const mocks: Record<string, unknown> = {
    "server-only": {},
    "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError },
    "@/lib/scope": scopeBase,
    "@/features/notifications/service.server": notifications,
    "@/features/planning/lifecycle.server": lifecycleStub,
  };
  return run(transpile("src/features/recovery", "approval.server.ts"), resolve("src/features/recovery", "approval.server.ts"), mocks) as {
    submitRecoveryPlan: (ctx: AuthContext, id: string) => Promise<unknown>;
  };
}

/* ----------------------------------- Tests -------------------------------- */
const active = (id: string, name: string, planned: boolean, noPlan = false): Row => ({ dealerId: id, name, isActive: true, status: "ACTIVE", planned, noPlan });
const inactive = (id: string, name: string): Row => ({ dealerId: id, name, isActive: false, status: "INACTIVE", planned: false });
const defaulter = (id: string, name: string): Row => ({ dealerId: id, name, isActive: true, status: "DEFAULTER", planned: false });

async function expectBlocked(fn: () => Promise<unknown>, nameFragment?: string) {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, "expected ApiError");
    assert.equal((e as ApiError).status, 422, "expected 422 completion-gate error");
    if (nameFragment) assert.ok((e as ApiError).message.includes(nameFragment), `message should mention ${nameFragment}: ${(e as ApiError).message}`);
    return true;
  });
}

async function main() {
  let pass = 0;

  // ---- Monthly (the reported module) ----
  // Case 1: active, unaccounted → blocked.
  await expectBlocked(() => loadMonthly([active("d1", "Kisan Beej Bhandar", false)], {}).submitMonthlyPlan(OWNER, "mp1"), "Kisan Beej Bhandar");
  pass++; console.log("  ok  Monthly: active unaccounted dealer blocks submission");

  // Case 2: active marked No Plan → allowed.
  {
    const res = await loadMonthly([active("d1", "Kisan", false, true)], {}).submitMonthlyPlan(OWNER, "mp1");
    assert.equal(res.status, "PENDING_ADMIN");
    pass++; console.log("  ok  Monthly: active dealer marked No Plan submits");
  }

  // Case 3: inactive, unaccounted → does NOT block (active dealers accounted for).
  {
    const rows = [active("d1", "Kisan", true), inactive("d2", "Yadav Khad Bhandar")];
    const res = await loadMonthly(rows, {}).submitMonthlyPlan(OWNER, "mp1");
    assert.equal(res.status, "PENDING_ADMIN");
    // Case 4: the inactive dealer's historical row is untouched/preserved (never deleted).
    assert.ok(rows.some((r) => r.dealerId === "d2" && !r.isActive), "inactive historical row preserved");
    pass++; console.log("  ok  Monthly: inactive unaccounted dealer does NOT block; its row is preserved");
  }

  // Defaulter also excluded (same eligibility rule as the view).
  {
    const res = await loadMonthly([active("d1", "Kisan", true), defaulter("d3", "Defaulter Dealer")], {}).submitMonthlyPlan(OWNER, "mp1");
    assert.equal(res.status, "PENDING_ADMIN");
    pass++; console.log("  ok  Monthly: defaulter unaccounted dealer does NOT block");
  }

  // Case 5: reactivated dealer becomes eligible again → unaccounted blocks once more.
  {
    const reactivated: Row = { dealerId: "d2", name: "Yadav Khad Bhandar", isActive: true, status: "ACTIVE", planned: false };
    await expectBlocked(() => loadMonthly([active("d1", "Kisan", true), reactivated], {}).submitMonthlyPlan(OWNER, "mp1"), "Yadav Khad Bhandar");
    pass++; console.log("  ok  Monthly: reactivated dealer is eligible again and blocks when unaccounted");
  }

  // Case 6: submission validation and the UI use consistent eligibility (gate applies the dealer filter).
  {
    const cap: { where?: Record<string, unknown> } = {};
    await loadMonthly([active("d1", "Kisan", true)], cap).submitMonthlyPlan(OWNER, "mp1");
    const df = cap.where?.dealer as { isActive?: boolean; status?: { not?: string } };
    assert.equal(df?.isActive, true, "gate must filter dealer.isActive = true (same as the view)");
    assert.equal(df?.status?.not, "DEFAULTER", "gate must exclude DEFAULTER (same as the view)");
    pass++; console.log("  ok  Monthly: gate uses the SAME eligibility filter as the view");
  }

  // Case 7: authorization — a non-owner cannot submit (403 before the gate).
  {
    await assert.rejects(
      () => loadMonthly([active("d1", "Kisan", true)], {}).submitMonthlyPlan(OTHER, "mp1"),
      (e: unknown) => e instanceof ApiError && (e as ApiError).status === 403,
    );
    pass++; console.log("  ok  Monthly: non-owner submission is forbidden (403)");
  }

  // ---- Seasonal (identical root cause) ----
  await expectBlocked(() => loadSeasonal([active("d1", "Kisan", false)], {}).submitPlan(OWNER, "sp1"), "Kisan");
  {
    const res = await loadSeasonal([active("d1", "Kisan", true), inactive("d2", "Yadav")], {}).submitPlan(OWNER, "sp1");
    assert.equal(res.status, "PENDING_ADMIN");
  }
  {
    const cap: { where?: Record<string, unknown> } = {};
    await loadSeasonal([active("d1", "Kisan", true)], cap).submitPlan(OWNER, "sp1");
    const df = cap.where?.dealer as { isActive?: boolean; status?: { not?: string } };
    assert.equal(df?.isActive, true);
    assert.equal(df?.status?.not, "DEFAULTER");
  }
  await assert.rejects(() => loadSeasonal([active("d1", "Kisan", true)], {}).submitPlan(OTHER, "sp1"), (e: unknown) => e instanceof ApiError && (e as ApiError).status === 403);
  pass++; console.log("  ok  Seasonal: active blocks / inactive excluded / consistent filter / auth intact");

  // ---- Recovery ----
  await expectBlocked(() => loadRecovery([active("d1", "Kisan", false)], {}).submitRecoveryPlan(OWNER, "rp1"), "Kisan");
  {
    await loadRecovery([active("d1", "Kisan", true), inactive("d2", "Yadav")], {}).submitRecoveryPlan(OWNER, "rp1"); // no throw
  }
  {
    const cap: { where?: Record<string, unknown> } = {};
    await loadRecovery([active("d1", "Kisan", true)], cap).submitRecoveryPlan(OWNER, "rp1");
    const df = cap.where?.dealer as { isActive?: boolean };
    assert.equal(df?.isActive, true, "recovery gate must filter dealer.isActive = true (same as its view)");
  }
  await assert.rejects(() => loadRecovery([active("d1", "Kisan", true)], {}).submitRecoveryPlan(OTHER, "rp1"), (e: unknown) => e instanceof ApiError && (e as ApiError).status === 403);
  pass++; console.log("  ok  Recovery: active blocks / inactive excluded / consistent filter / auth intact");

  console.log(`\n${pass} plan-submit eligibility tests passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
