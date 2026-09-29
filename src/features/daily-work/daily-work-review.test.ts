/**
 * Phase 2 — RM Team Performance + immutable RM review. Loads the real service with a DB-free fake and mocked
 * scope helpers (group-based hierarchy). Proves the AUTHORITATIVE server behavior: team scoping, submission
 * gating, rating validation, immutability/duplicate prevention, and summary averaging (missing ≠ 0).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Prisma, Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";
import { dailyWorkServiceInfrastructureMocks } from "./service-test-mocks";

class TestApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

// ---- Test directory of users (group-based hierarchy) ----
const USERS: { id: string; name: string; role: Role; groupId: string | null }[] = [
  { id: "rm1", name: "RM One", role: Role.REGIONAL_MANAGER, groupId: "g1" },
  { id: "so1", name: "Rahul", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "so2", name: "Amit", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "rm2", name: "RM Two", role: Role.REGIONAL_MANAGER, groupId: "g2" },
  { id: "so3", name: "Ravi", role: Role.SALES_OFFICER, groupId: "g2" },
];
const DATE = "2026-09-27";
const GROUP_NAMES: Record<string, string> = { g1: "Group A", g2: "Group B" };

interface Store {
  submitted: Set<string>; // officerIds with a SUBMITTED day (for DATE)
  self: Map<string, number | null>; // officerId → selfRating
  reviews: Map<string, { rating: number; reviewerId: string }>; // officerId → review (for DATE)
}

function makeFake(init: Partial<Store> = {}) {
  const store: Store = { submitted: init.submitted ?? new Set(), self: init.self ?? new Map(), reviews: init.reviews ?? new Map() };
  const norm = (a: unknown, rest: unknown[]): Prisma.Sql => (Array.isArray(a) ? Prisma.sql(a as unknown as TemplateStringsArray, ...rest) : (a as Prisma.Sql));

  function runRaw(sql: Prisma.Sql): unknown {
    const text = sql.sql.replace(/\s+/g, " ").trim();
    const v = sql.values as unknown[];
    if (text.startsWith('SELECT e."dealerId", SUM(t."contribution")')) return [];
    if (text.startsWith('SELECT DISTINCT t."entryId"')) return [];
    // Team: submitted officers for the date.
    if (text.startsWith('SELECT "officerId" FROM "DailyWorkDay"')) {
      return [...store.submitted].map((officerId) => ({ officerId }));
    }
    // Team: self-ratings (SUMMARY rows).
    if (text.includes('SELECT "officerId", "selfRating"')) {
      return [...store.self.entries()].map(([officerId, selfRating]) => ({ officerId, selfRating }));
    }
    // Team: RM ratings.
    if (text.includes('SELECT "officerId", "rating" FROM "DailyWorkReview"')) {
      return [...store.reviews.entries()].map(([officerId, r]) => ({ officerId, rating: r.rating }));
    }
    // isDailyWorkSubmitted(officerId) — EXISTS query, officerId is the first value.
    if (text.startsWith('SELECT EXISTS(') && text.includes('"DailyWorkDay"')) {
      return [{ submitted: store.submitted.has(v[0] as string) }];
    }
    if (text.startsWith('SELECT "currentBatchId", "status", "selfRating", "finalizedAt"')) {
      const officerId = v[0] as string;
      return store.submitted.has(officerId)
        ? [{ currentBatchId: `locked:${officerId}:${v[1] as string}`, status: "FINALIZED", selfRating: store.self.get(officerId) ?? null, finalizedAt: new Date("2026-09-27T10:00:00.000Z") }]
        : [];
    }
    // Empty section rows used by the consolidated read-only detail.
    if (text.startsWith('SELECT "id", "batchId", "dealerId", "rowKey"')) return [];
    if (text.startsWith('SELECT "id", "batchId", "dealerVisits"')) return [];
    if (text.startsWith('SELECT "section", "batchId"')) return [];
    if (text.startsWith('SELECT "section", COUNT(*)')) return [];
    if (text.startsWith('SELECT ("dealerVisits" IS NOT NULL')) return [];
    if (text.startsWith('SELECT "noPlanSections"')) return [];
    if (text.startsWith('SELECT "selfRating" FROM "DailyWorkEntry"')) {
      return [{ selfRating: store.self.get(v[0] as string) ?? null }];
    }
    // loadDailyWorkReview(officerId) join User.
    if (text.startsWith('SELECT r."rating"')) {
      const officerId = v[0] as string;
      const r = store.reviews.get(officerId);
      if (!r) return [];
      const reviewer = USERS.find((u) => u.id === r.reviewerId);
      return [{ rating: r.rating, reviewerId: r.reviewerId, reviewerName: reviewer?.name ?? "?", reviewedAt: new Date("2026-09-27T10:00:00.000Z") }];
    }
    // Insert review ON CONFLICT DO NOTHING (values: [id, officerId, workDate, reviewerId, rating]).
    if (text.startsWith('INSERT INTO "DailyWorkReview"')) {
      const officerId = v[1] as string;
      const reviewerId = v[3] as string;
      const rating = v[4] as number;
      if (store.reviews.has(officerId)) return 0; // unique(officerId, workDate) — duplicate rejected
      store.reviews.set(officerId, { rating, reviewerId });
      return 1;
    }
    throw new Error("Unhandled SQL: " + text);
  }

  const prisma = {
    $queryRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    $executeRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    user: {
      findMany: async ({ where, select }: { where: { role?: Role; isActive?: boolean; id?: { in: string[] } }; select?: Record<string, unknown> }) => {
        return USERS
          .filter((u) => (where.role ? u.role === where.role : true))
          .filter((u) => (where.id?.in ? where.id.in.includes(u.id) : true))
          .map((u) => {
            const out: Record<string, unknown> = { id: u.id, name: u.name };
            if (select?.groupId) out.groupId = u.groupId;
            if (select?.group) out.group = u.groupId ? { id: u.groupId, name: GROUP_NAMES[u.groupId] } : null;
            return out;
          });
      },
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const u = USERS.find((x) => x.id === where.id);
        if (!u) return null;
        const out: Record<string, unknown> = {};
        if (select?.role) out.role = u.role;
        if (select?.name) out.name = u.name;
        if (select?.groupId) out.groupId = u.groupId;
        if (select?.isActive) out.isActive = true;
        if (select?.deletedAt) out.deletedAt = null;
        return out;
      },
    },
    recoveryPlan: { findFirst: async () => null },
    dealerSchemePlan: { findMany: async () => [] },
    dealer: { findMany: async () => [] },
    auditLog: { create: async () => ({}) },
  };
  return { prisma, store };
}

const localRequire = createRequire(import.meta.url);
function loadService(prisma: object, labelOverrides: Record<string, string> = {}) {
  const filename = resolve("src/features/daily-work", "service.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};

  // Real group-based scope logic, backed by the test USERS directory.
  const getOfficerScope = async (ctx: AuthContext) => {
    if (ctx.role === Role.SUPER_ADMIN) return { all: true, ids: [] as string[] };
    if (ctx.role === Role.SALES_OFFICER) return { all: false, ids: [ctx.userId] };
    const self = USERS.find((u) => u.id === ctx.userId);
    const sos = USERS.filter((u) => u.role === Role.SALES_OFFICER && u.groupId === self?.groupId).map((u) => u.id);
    return { all: false, ids: [ctx.userId, ...sos] };
  };
  const assertOfficerInScope = async (ctx: AuthContext, officerId: string) => {
    const scope = await getOfficerScope(ctx);
    if (!scope.all && !scope.ids.includes(officerId)) throw new TestApiError(403, "You do not have access to this Sales Officer's data");
  };

  const mocks: Record<string, unknown> = {
    ...dailyWorkServiceInfrastructureMocks(prisma as never),
    "server-only": {}, "@/lib/prisma": { prisma },
    "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => 0 },
    "@/lib/http": { ApiError: TestApiError },
    "@/lib/scope": { getCurrentDealerIds: async () => [], getOfficerScope, assertOfficerInScope },
    "@/lib/audit": { writeAudit: async () => ({}) },
    "@/features/labels/service.server": { getResolvedLabels: async () => ({ ...localRequire(resolve("src/features/labels", "labels.ts")).DEFAULT_LABELS, ...labelOverrides }) },
    "@/features/schemes/scheme-planning.server": { runningSchemes: async () => [] },
    "@/features/planning/monthly.server": { getMonthly: async () => ({ monthlyMode: "PACK_SIZE", months: [], dealers: [] }) },
    "@/features/planning/monthly-plan.server": { resolveAddableSeasonalPlanId: async () => null },
    "@/lib/scheme-plan-quantity": localRequire(resolve("src/lib", "scheme-plan-quantity.ts")),
    "@/lib/calc": localRequire(resolve("src/lib", "calc.ts")),
    "@/lib/daily-work": localRequire(resolve("src/lib", "daily-work.ts")),
  };
  runInNewContext(code, { exports, Date, console, crypto, require: (id: string) => (id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id)) }, { filename });
  return exports as typeof import("./service.server");
}

const RM1: AuthContext = { userId: "rm1", role: Role.REGIONAL_MANAGER, username: "rm1", groupId: "g1" } as AuthContext;
const RM2: AuthContext = { userId: "rm2", role: Role.REGIONAL_MANAGER, username: "rm2", groupId: "g2" } as AuthContext;
const SO1: AuthContext = { userId: "so1", role: Role.SALES_OFFICER, username: "so1", groupId: "g1" } as AuthContext;
const ADMIN: AuthContext = { userId: "admin1", role: Role.SUPER_ADMIN, username: "admin1", groupId: null } as AuthContext;

async function expectStatus(fn: () => Promise<unknown>, status: number, label: string) {
  try { await fn(); assert.fail(`${label}: expected ${status} but succeeded`); }
  catch (e) { assert.equal((e as { status?: number }).status, status, `${label}: wrong status (${(e as Error).message})`); }
}

async function main() {
  // 1) RM sees ONLY their group's SOs; unrelated SO (g2) is never listed.
  {
    const f = makeFake({ submitted: new Set(["so1"]), self: new Map([["so1", 8]]) });
    const svc = loadService(f.prisma);
    const p = await svc.getTeamPerformance(RM1, DATE);
    const ids = p.rows.map((r) => r.officerId).sort();
    assert.deepEqual(ids, ["so1", "so2"], "RM1 sees only g1 SOs");
    assert.ok(!ids.includes("so3"), "unrelated g2 SO excluded");
    assert.ok(!ids.includes("rm1"), "RM themselves not a team row");
  }

  // 2) A Sales Officer cannot access Team Performance at all.
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    await expectStatus(() => svc.getTeamPerformance(SO1, DATE), 403, "SO cannot view team performance");
  }

  // 3) Submission + rating columns; missing ratings are null (→ "—"), never 0.
  {
    const f = makeFake({ submitted: new Set(["so1"]), self: new Map([["so1", 8]]), reviews: new Map([["so1", { rating: 7, reviewerId: "rm1" }]]) });
    const svc = loadService(f.prisma);
    const p = await svc.getTeamPerformance(RM1, DATE);
    const so1 = p.rows.find((r) => r.officerId === "so1")!;
    const so2 = p.rows.find((r) => r.officerId === "so2")!;
    assert.equal(so1.submitted, true);
    assert.equal(so1.selfRating, 8);
    assert.equal(so1.rmRating, 7);
    assert.equal(so2.submitted, false, "so2 not submitted");
    assert.equal(so2.selfRating, null, "no self rating → null, not 0");
    assert.equal(so2.rmRating, null, "no RM rating → null, not 0");
  }

  // 4) Summary: counts + averages exclude missing (missing ≠ 0); "—" (null) when no ratings.
  {
    const f = makeFake({ submitted: new Set(["so1"]), self: new Map([["so1", 8]]), reviews: new Map([["so1", { rating: 7, reviewerId: "rm1" }]]) });
    const svc = loadService(f.prisma);
    const { summary } = await svc.getTeamPerformance(RM1, DATE);
    assert.equal(summary.salesOfficers, 2);
    assert.equal(summary.submitted, 1);
    assert.equal(summary.notSubmitted, 1);
    assert.equal(summary.averageSelfRating, 8, "average over the single available self-rating (not divided by 2)");
    assert.equal(summary.averageRmRating, 7);
  }
  {
    const f = makeFake({ submitted: new Set(["so1", "so2"]), self: new Map([["so1", 8], ["so2", 6]]) });
    const svc = loadService(f.prisma);
    const { summary } = await svc.getTeamPerformance(RM1, DATE);
    assert.equal(summary.averageSelfRating, 7, "(8+6)/2");
    assert.equal(summary.averageRmRating, null, "no RM ratings → null (—), not 0");
  }

  // 5) Rating validation on create (fully valid target: so1 submitted).
  for (const good of [1, 5, 10]) {
    const f = makeFake({ submitted: new Set(["so1"]) });
    const svc = loadService(f.prisma);
    const r = await svc.createDailyWorkReview(RM1, { officerId: "so1", workDate: DATE, rating: good });
    assert.equal(r.rating, good, `rating ${good} accepted`);
    assert.equal(f.store.reviews.get("so1")?.rating, good);
  }
  for (const bad of [0, 11, -1, 5.5]) {
    const f = makeFake({ submitted: new Set(["so1"]) });
    const svc = loadService(f.prisma);
    await expectStatus(() => svc.createDailyWorkReview(RM1, { officerId: "so1", workDate: DATE, rating: bad }), 422, `rating ${bad} rejected`);
    assert.equal(f.store.reviews.has("so1"), false);
  }
  {
    const f = makeFake({ submitted: new Set(["so1"]) });
    const svc = loadService(f.prisma);
    await expectStatus(() => svc.createDailyWorkReview(RM1, { officerId: "so1", workDate: DATE }), 422, "missing rating rejected");
  }

  // 6) Draft (not submitted) cannot be rated.
  {
    const f = makeFake({ submitted: new Set() });
    const svc = loadService(f.prisma);
    await expectStatus(() => svc.createDailyWorkReview(RM1, { officerId: "so1", workDate: DATE, rating: 7 }), 409, "draft cannot be rated");
  }

  // 7) A Sales Officer cannot create an RM review.
  {
    const f = makeFake({ submitted: new Set(["so2"]) });
    const svc = loadService(f.prisma);
    await expectStatus(() => svc.createDailyWorkReview(SO1, { officerId: "so2", workDate: DATE, rating: 7 }), 403, "SO cannot review");
  }

  // 8) An unrelated RM cannot rate another team's SO.
  {
    const f = makeFake({ submitted: new Set(["so1"]) });
    const svc = loadService(f.prisma);
    await expectStatus(() => svc.createDailyWorkReview(RM2, { officerId: "so1", workDate: DATE, rating: 7 }), 403, "unrelated RM cannot review");
  }

  // 9) Immutability + duplicate/concurrent prevention: a second review is rejected and the first is unchanged.
  {
    const f = makeFake({ submitted: new Set(["so1"]) });
    const svc = loadService(f.prisma);
    await svc.createDailyWorkReview(RM1, { officerId: "so1", workDate: DATE, rating: 7 });
    await expectStatus(() => svc.createDailyWorkReview(RM1, { officerId: "so1", workDate: DATE, rating: 3 }), 409, "cannot re-review");
    assert.equal(f.store.reviews.get("so1")?.rating, 7, "original rating unchanged (immutable)");
  }

  // 10) Existing review is returned to the reviewer via the detail guard path (403/409 short-circuits reach here).
  {
    const f = makeFake({ submitted: new Set(["so1"]), reviews: new Map([["so1", { rating: 9, reviewerId: "rm1" }]]) });
    const svc = loadService(f.prisma);
    const detail = await svc.getDailyWorkReviewDetail(RM1, "so1", DATE);
    assert.equal(detail.review?.rating, 9, "authorized RM still reads their team member's detail");
    // Detail for an unrelated RM is forbidden before any section read.
    await expectStatus(() => svc.getDailyWorkReviewDetail(RM2, "so1", DATE), 403, "unrelated RM cannot view detail");
    // Detail for an unsubmitted officer is 409 before any section read.
    await expectStatus(() => svc.getDailyWorkReviewDetail(RM1, "so2", DATE), 409, "unsubmitted detail rejected");
  }

  // ===================== Phase 3 — Admin company-wide performance =====================

  // 11) Admin sees SOs across ALL groups with correct RM + group; RM/SO are forbidden.
  {
    const f = makeFake({ submitted: new Set(["so1", "so3"]), self: new Map([["so1", 8], ["so3", 6]]), reviews: new Map([["so1", { rating: 7, reviewerId: "rm1" }]]) });
    const svc = loadService(f.prisma);
    const p = await svc.getAdminPerformance(ADMIN, { date: DATE });
    assert.deepEqual(p.rows.map((r) => r.officerId).sort(), ["so1", "so2", "so3"], "all groups' SOs");
    const so1 = p.rows.find((r) => r.officerId === "so1")!;
    const so3 = p.rows.find((r) => r.officerId === "so3")!;
    assert.equal(so1.rmName, "RM One"); assert.equal(so1.groupName, "Group A");
    assert.equal(so3.rmName, "RM Two"); assert.equal(so3.groupName, "Group B");
    assert.equal(so1.submitted, true); assert.equal(so1.selfRating, 8); assert.equal(so1.rmRating, 7);
    const so2 = p.rows.find((r) => r.officerId === "so2")!;
    assert.equal(so2.submitted, false); assert.equal(so2.selfRating, null); assert.equal(so2.rmRating, null);
    await expectStatus(() => svc.getAdminPerformance(RM1, { date: DATE }), 403, "RM cannot view admin performance");
    await expectStatus(() => svc.getAdminPerformance(SO1, { date: DATE }), 403, "SO cannot view admin performance");
  }

  // 12) Summary averages exclude missing (missing ≠ 0); "—" (null) when none.
  {
    const f = makeFake({ submitted: new Set(["so1", "so3"]), self: new Map([["so1", 8], ["so3", 6]]), reviews: new Map([["so1", { rating: 7, reviewerId: "rm1" }]]) });
    const svc = loadService(f.prisma);
    const { summary } = await svc.getAdminPerformance(ADMIN, { date: DATE });
    assert.equal(summary.salesOfficers, 3);
    assert.equal(summary.submitted, 2);
    assert.equal(summary.notSubmitted, 1);
    assert.equal(summary.averageSelfRating, 7, "(8+6)/2, so2's missing not counted");
    assert.equal(summary.averageRmRating, 7, "single RM rating; not divided by the whole team");
  }
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    const { summary } = await svc.getAdminPerformance(ADMIN, { date: DATE });
    assert.equal(summary.averageSelfRating, null, "no self ratings → null (—)");
    assert.equal(summary.averageRmRating, null, "no RM ratings → null (—)");
  }

  // 13) Filters: group, RM, submission (server-side).
  {
    const f = makeFake({ submitted: new Set(["so1"]) });
    const svc = loadService(f.prisma);
    const byGroup = await svc.getAdminPerformance(ADMIN, { date: DATE, groupId: "g2" });
    assert.deepEqual(byGroup.rows.map((r) => r.officerId), ["so3"], "group filter → only g2");
    const byRm = await svc.getAdminPerformance(ADMIN, { date: DATE, rmId: "rm1" });
    assert.deepEqual(byRm.rows.map((r) => r.officerId).sort(), ["so1", "so2"], "RM filter → rm1's group");
    const submittedOnly = await svc.getAdminPerformance(ADMIN, { date: DATE, submission: "SUBMITTED" });
    assert.deepEqual(submittedOnly.rows.map((r) => r.officerId), ["so1"]);
    const notSubmitted = await svc.getAdminPerformance(ADMIN, { date: DATE, submission: "NOT_SUBMITTED" });
    assert.deepEqual(notSubmitted.rows.map((r) => r.officerId).sort(), ["so2", "so3"]);
    // Filter options come from the whole population regardless of the active filter.
    assert.equal(byGroup.groups.map((g) => g.name).join("|"), "Group A|Group B");
    assert.equal(byGroup.rms.map((r) => r.name).join("|"), "RM One|RM Two");
  }

  // 14) Admin can read a submitted SO's detail (read-only path); Admin can NEVER create a review.
  {
    const f = makeFake({ submitted: new Set(["so1"]), self: new Map([["so1", 8]]), reviews: new Map([["so1", { rating: 9, reviewerId: "rm1" }]]) });
    const svc = loadService(f.prisma);
    const detail = await svc.getDailyWorkReviewDetail(ADMIN, "so1", DATE);
    assert.equal(detail.officerId, "so1", "admin can inspect the requested submitted Sales Officer");
    assert.equal(detail.officerName, "Rahul");
    assert.equal(detail.selfRating, 8);
    assert.equal(detail.review?.rating, 9);
    await expectStatus(() => svc.getDailyWork(ADMIN, "SALES", DATE), 403, "admin is not a Daily Work owner without a targeted read");
    await expectStatus(() => svc.createDailyWorkReview(ADMIN, { officerId: "so1", workDate: DATE, rating: 5 }), 403, "admin cannot create a review");
    assert.equal(f.store.reviews.get("so1")?.rating, 9, "existing RM review unchanged by admin");
    // Detail of an unsubmitted officer is still gated for admin.
    await expectStatus(() => svc.getDailyWorkReviewDetail(ADMIN, "so2", DATE), 409, "admin detail requires submitted");
  }

  // 15) The Admin Daily Work viewer validates Date + State + SO and reuses the complete submitted-report read.
  {
    const f = makeFake({ submitted: new Set(["so1"]), self: new Map([["so1", 8]]), reviews: new Map([["so1", { rating: 9, reviewerId: "rm1" }]]) });
    const svc = loadService(f.prisma);
    const detail = await svc.getAdminDailyWorkView(ADMIN, { workDate: DATE, groupId: "g1", officerId: "so1" });
    assert.equal(detail.officerId, "so1");
    assert.equal(detail.workDate, DATE);
    assert.equal(detail.selfRating, 8);
    assert.equal(detail.review?.rating, 9);
    assert.ok(detail.sales && detail.recovery && detail.appointment && detail.conversion && detail.summary, "all six-section report sources are returned");
    assert.equal(detail.reportSections.length, 6, "existing completion metadata for all sections is preserved");
  }

  // 16) State/SO pairing is server-authoritative; a mismatched State cannot retrieve the officer's report.
  {
    const f = makeFake({ submitted: new Set(["so1"]) });
    const svc = loadService(f.prisma);
    await expectStatus(() => svc.getAdminDailyWorkView(ADMIN, { workDate: DATE, groupId: "g2", officerId: "so1" }), 403, "Admin state/officer mismatch");
    await expectStatus(() => svc.getAdminDailyWorkView(ADMIN, { workDate: DATE, groupId: "g1", officerId: "rm1" }), 403, "Admin target must be an SO");
  }

  // 17) The targeted endpoint is Admin-only and never exposes a draft as a submitted report.
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    await expectStatus(() => svc.getAdminDailyWorkView(RM1, { workDate: DATE, groupId: "g1", officerId: "so1" }), 403, "RM cannot use Admin viewer");
    await expectStatus(() => svc.getAdminDailyWorkView(SO1, { workDate: DATE, groupId: "g1", officerId: "so1" }), 403, "SO cannot use Admin viewer");
    await expectStatus(() => svc.getAdminDailyWorkView(ADMIN, { workDate: "2026-02-30", groupId: "g1", officerId: "so1" }), 422, "invalid calendar date is rejected");
    await expectStatus(() => svc.getAdminDailyWorkView(ADMIN, { workDate: DATE, groupId: "g1", officerId: "so1" }), 409, "draft/unsubmitted day is not returned");
    await expectStatus(() => svc.saveDailyWork(ADMIN, { section: "SALES", workDate: DATE, rows: [] }), 403, "Admin cannot mutate Daily Work");
  }

  console.log("daily-work-review.test.ts — all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
