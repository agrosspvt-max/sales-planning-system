/**
 * Phase 4 — role-aware, date-range performance + attendance. Loads the real service with a DB-free fake and
 * mocked group-based scope. Proves: role scoping, date-range windowing, attendance default/override/persistence
 * and write-authorization, plan/report timestamp sources, ratings/averages (missing ≠ 0), filters, detail
 * authorization, and that the range report uses a FIXED number of batched queries (no N+1).
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

const USERS: { id: string; name: string; role: Role; groupId: string | null }[] = [
  { id: "rm1", name: "RM One", role: Role.REGIONAL_MANAGER, groupId: "g1" },
  { id: "so1", name: "Rahul", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "so2", name: "Amit", role: Role.SALES_OFFICER, groupId: "g1" },
  { id: "rm2", name: "RM Two", role: Role.REGIONAL_MANAGER, groupId: "g2" },
  { id: "so3", name: "Ravi", role: Role.SALES_OFFICER, groupId: "g2" },
  { id: "so4", name: "Bina", role: Role.SALES_OFFICER, groupId: "g3" },
  { id: "so5", name: "Chetan", role: Role.SALES_OFFICER, groupId: "g4" },
];
const GROUP_NAMES: Record<string, string> = { g1: "MP", g2: "UP", g3: "WB", g4: "CG" };
const D = (s: string) => new Date(`${s}T00:00:00.000Z`); // date-only key → Date
const TS = (s: string) => new Date(s); // full ISO timestamp

interface Store {
  plans: Map<string, Date>;      // oid|date → earliest planSubmittedAt
  days: Map<string, { finalizedAt: Date | null; selfRating: number | null }>;
  reviews: Map<string, number>;  // oid|date → rm rating
  attendance: Map<string, string>;
  rawCount: number;              // # of $queryRaw calls (to assert N+1 boundedness)
}

function makeFake(init: Partial<Store> = {}) {
  const store: Store = {
    plans: init.plans ?? new Map(), days: init.days ?? new Map(),
    reviews: init.reviews ?? new Map(), attendance: init.attendance ?? new Map(), rawCount: 0,
  };
  const norm = (a: unknown, rest: unknown[]): Prisma.Sql => (Array.isArray(a) ? Prisma.sql(a as unknown as TemplateStringsArray, ...rest) : (a as Prisma.Sql));
  const inRange = (key: string, ids: string[], from: string, to: string) => {
    const [oid, date] = key.split("|");
    return ids.includes(oid) && date >= from && date <= to;
  };
  const rowsFrom = <T>(map: Map<string, T>, ids: string[], from: string, to: string, build: (oid: string, date: string, v: T) => unknown) =>
    [...map.entries()].filter(([k]) => inRange(k, ids, from, to)).map(([k, v]) => { const [oid, date] = k.split("|"); return build(oid, date, v); });

  function runRaw(sql: Prisma.Sql, isQuery: boolean): unknown {
    const text = sql.sql.replace(/\s+/g, " ").trim();
    const v = sql.values as unknown[];
    if (text.startsWith('SELECT e."dealerId", SUM(t."contribution")')) return [];
    if (isQuery) store.rawCount += 1;
    if (text.startsWith('INSERT INTO "DailyWorkAttendance"')) {
      store.attendance.set(`${v[1]}|${v[2]}`, v[3] as string); return 1;
    }
    // Range queries: values = [...ids, from, to]
    const to = v[v.length - 1] as string;
    const from = v[v.length - 2] as string;
    const ids = v.slice(0, v.length - 2) as string[];
    if (text.includes('MIN("planSubmittedAt")')) {
      return rowsFrom(store.plans, ids, from, to, (oid, date, ts_) => ({ officerId: oid, workDate: D(date), planSubmittedAt: ts_ }));
    }
    if (text.includes('FROM "DailyWorkDay"')) {
      return rowsFrom(store.days, ids, from, to, (oid, date, d) => ({ officerId: oid, workDate: D(date), finalizedAt: d.finalizedAt, selfRating: d.selfRating, status: d.finalizedAt ? "FINALIZED" : "OPEN" }));
    }
    if (text.includes('FROM "DailyWorkReview"')) {
      return rowsFrom(store.reviews, ids, from, to, (oid, date, rating) => ({ officerId: oid, workDate: D(date), rating }));
    }
    if (text.includes('FROM "DailyWorkAttendance"')) {
      return rowsFrom(store.attendance, ids, from, to, (oid, date, status) => ({ officerId: oid, workDate: D(date), status }));
    }
    throw new Error("Unhandled SQL: " + text);
  }

  const prisma = {
    $queryRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest), true),
    $executeRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest), false),
    user: {
      findMany: async ({ where, select }: { where: { role?: Role; id?: { in: string[] } }; select?: Record<string, unknown> }) =>
        USERS.filter((u) => (where.role ? u.role === where.role : true)).filter((u) => (where.id?.in ? where.id.in.includes(u.id) : true))
          .map((u) => { const o: Record<string, unknown> = { id: u.id, name: u.name }; if (select?.groupId) o.groupId = u.groupId; if (select?.group) o.group = u.groupId ? { id: u.groupId, name: GROUP_NAMES[u.groupId] } : null; return o; }),
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const u = USERS.find((x) => x.id === where.id); if (!u) return null;
        const o: Record<string, unknown> = {};
        if (select?.id) o.id = u.id; if (select?.role) o.role = u.role; if (select?.name) o.name = u.name; if (select?.groupId) o.groupId = u.groupId;
        if (select?.group) (o as { group?: unknown }).group = u.groupId ? { id: u.groupId, name: GROUP_NAMES[u.groupId] } : null;
        return o;
      },
    },
    auditLog: { create: async () => ({}) },
  };
  return { prisma, store };
}

const localRequire = createRequire(import.meta.url);
function loadService(prisma: object) {
  const filename = resolve("src/features/daily-work", "service.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const getOfficerScope = async (ctx: AuthContext) => {
    if (ctx.role === Role.SUPER_ADMIN) return { all: true, ids: [] as string[] };
    if (ctx.role === Role.SALES_OFFICER) return { all: false, ids: [ctx.userId] };
    const self = USERS.find((u) => u.id === ctx.userId);
    return { all: false, ids: [ctx.userId, ...USERS.filter((u) => u.role === Role.SALES_OFFICER && u.groupId === self?.groupId).map((u) => u.id)] };
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
    "@/features/labels/service.server": { getResolvedLabels: async () => localRequire(resolve("src/features/labels", "labels.ts")).DEFAULT_LABELS },
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
const cell = (r: { officerId: string; date: string }) => `${r.officerId}|${r.date}`;

async function main() {
  const RANGE = { from: "2026-09-27", to: "2026-09-29" }; // 3 days

  // RM Team Performance reuses the same authoritative defaults and range validation as SO My Performance.
  {
    const svc = loadService(makeFake().prisma);
    const p = await svc.getDailyPerformance(RM1);
    assert.equal(p.from, p.to, "default From and To are both the current business date");
    assert.equal(p.rows.length, 2, "one default-date row for each officer in the RM's team");
    await expectStatus(() => svc.getDailyPerformance(RM1, { from: "2026-09-29", to: "2026-09-28" }), 422, "From after To is rejected");
    await expectStatus(() => svc.getDailyPerformance(RM1, { from: "2026-01-01", to: "2026-04-03" }), 422, "range over 92 days is rejected");
  }

  // The RM-only page uses the shared from/to API and keeps each officer-date visible and reviewable.
  {
    const page = readFileSync(resolve("src/features/daily-work/team-performance-page.tsx"), "utf8");
    assert.match(page, /const \[from, setFrom\] = useState\(currentBusinessDate\)/);
    assert.match(page, /const \[to, setTo\] = useState\(currentBusinessDate\)/);
    assert.match(page, /new URLSearchParams\(\{ from, to \}\)/);
    assert.match(page, /\/api\/daily-work\/performance\?\$\{query\.toString\(\)\}/);
    assert.doesNotMatch(page, /\/api\/daily-work\/team\?date=/, "the RM page no longer uses the single-date API");
    assert.match(page, /key=\{`\$\{r\.officerId\}-\$\{r\.date\}`\}/, "the table renders one row per officer per date");
    assert.match(page, /workDate=\{openOfficer\.date\}/, "the action opens the selected row's business date");
    assert.match(page, /data\.summary\.submittedReports/, "range summary uses finalized report submissions");
  }

  // 1) SO sees only their own rows; no other officers, regardless of a spoofed officerId.
  {
    const svc = loadService(makeFake().prisma);
    const p = await svc.getDailyPerformance(SO1, { ...RANGE, officerId: "so2" });
    assert.equal(p.role, Role.SALES_OFFICER);
    assert.deepEqual([...new Set(p.rows.map((r) => r.officerId))], ["so1"], "SO sees only own");
    assert.equal(p.rows.length, 3, "3 days");
    assert.equal(p.canEditAttendance, false);
  }

  // 2) RM sees only their team (g1: so1, so2), never another team's SO.
  {
    const svc = loadService(makeFake().prisma);
    const p = await svc.getDailyPerformance(RM1, RANGE);
    assert.deepEqual([...new Set(p.rows.map((r) => r.officerId))].sort(), ["so1", "so2"]);
    assert.equal(p.rows.length, 6, "2 officers × 3 days");
  }
  // RM cannot request an unrelated SO.
  {
    const svc = loadService(makeFake().prisma);
    await expectStatus(() => svc.getDailyPerformance(RM1, { ...RANGE, officerId: "so3" }), 403, "RM cannot access other team");
  }

  // 3) Admin sees all SOs across groups; N+1 GUARD: exactly 4 batched range queries regardless of officers×days.
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    const p = await svc.getDailyPerformance(ADMIN, RANGE);
    assert.deepEqual([...new Set(p.rows.map((r) => r.officerId))].sort(), ["so1", "so2", "so3", "so4", "so5"]);
    assert.equal(p.rows.length, 15, "5 officers × 3 days");
    assert.equal(f.store.rawCount, 4, "fixed 4 batched range queries — no N+1");
  }

  // 4) Date range windowing: records outside the range are excluded; single-day works.
  {
    const f = makeFake({ plans: new Map([["so1|2026-09-28", D("2026-09-28")], ["so1|2026-10-05", D("2026-10-05")]]) });
    const svc = loadService(f.prisma);
    const p = await svc.getDailyPerformance(SO1, RANGE);
    assert.equal(p.rows[0]?.date, RANGE.from, "From date is included");
    assert.equal(p.rows.at(-1)?.date, RANGE.to, "To date is included");
    assert.equal(p.rows.find((r) => r.date === "2026-09-28")?.submitted, true);
    assert.ok(!p.rows.some((r) => r.date === "2026-10-05"), "out-of-range excluded");
    const single = await svc.getDailyPerformance(SO1, { from: "2026-09-28", to: "2026-09-28" });
    assert.equal(single.rows.length, 1);
  }

  // 5) Attendance default Present; Not Submitted does NOT become Absent.
  {
    const svc = loadService(makeFake().prisma);
    const p = await svc.getDailyPerformance(SO1, RANGE);
    assert.ok(p.rows.every((r) => r.attendance === "PRESENT"), "default Present");
    assert.ok(p.rows.every((r) => r.submitted === false), "no submission");
    assert.equal(p.summary.presentDays, 3);
  }

  // 6) Admin sets attendance (Present→Absent/Leave/Holiday); persists across reads. SO/RM cannot set.
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    for (const status of ["ABSENT", "LEAVE", "HOLIDAY"] as const) {
      await svc.setDailyWorkAttendance(ADMIN, { officerId: "so1", workDate: "2026-09-28", status });
      const p = await svc.getDailyPerformance(ADMIN, { ...RANGE, officerId: "so1" });
      assert.equal(p.rows.find((r) => r.date === "2026-09-28")?.attendance, status, `persisted ${status}`);
    }
    // present days now 2 of 3 (28th is HOLIDAY)
    const after = await svc.getDailyPerformance(ADMIN, { ...RANGE, officerId: "so1" });
    assert.equal(after.summary.presentDays, 2);
    await expectStatus(() => svc.setDailyWorkAttendance(SO1, { officerId: "so1", workDate: "2026-09-28", status: "ABSENT" }), 403, "SO cannot set attendance");
    await expectStatus(() => svc.setDailyWorkAttendance(RM1, { officerId: "so1", workDate: "2026-09-28", status: "ABSENT" }), 403, "RM cannot set attendance");
  }

  // 7) Plan/report timestamps come from their independent sources; missing → null.
  {
    const plan = TS("2026-09-28T09:15:00.000Z");
    const report = TS("2026-09-28T18:30:00.000Z");
    const f = makeFake({
      plans: new Map([["so1|2026-09-28", plan]]),
      days: new Map([["so1|2026-09-28", { finalizedAt: report, selfRating: 8 }]]),
      reviews: new Map([["so1|2026-09-28", 7]]),
    });
    const svc = loadService(f.prisma);
    const row = (await svc.getDailyPerformance(SO1, RANGE)).rows.find((r) => r.date === "2026-09-28")!;
    assert.equal(row.planSubmittedAt, plan.toISOString());
    assert.equal(row.reportSubmittedAt, report.toISOString());
    assert.notEqual(row.planSubmittedAt, row.reportSubmittedAt, "plan and report timestamps are independent");
    assert.equal(row.selfRating, 8);
    assert.equal(row.rmRating, 7);
    const empty = (await svc.getDailyPerformance(SO1, RANGE)).rows.find((r) => r.date === "2026-09-27")!;
    assert.equal(empty.planSubmittedAt, null); assert.equal(empty.reportSubmittedAt, null);
    assert.equal(empty.selfRating, null); assert.equal(empty.rmRating, null);
  }

  // 8) Averages exclude missing ratings (never 0); self-rating only when finalized.
  {
    const f = makeFake({
      days: new Map([
        ["so1|2026-09-27", { finalizedAt: TS("2026-09-27T18:00:00Z"), selfRating: 8 }],
        ["so2|2026-09-27", { finalizedAt: TS("2026-09-27T18:00:00Z"), selfRating: 6 }],
        ["so2|2026-09-28", { finalizedAt: null, selfRating: 9 }], // not finalized → self rating not surfaced
      ]),
      reviews: new Map([["so1|2026-09-27", 7]]),
    });
    const svc = loadService(f.prisma);
    const p = await svc.getDailyPerformance(RM1, RANGE);
    assert.equal(p.summary.averageSelfRating, 7, "(8+6)/2; the non-finalized 9 is excluded");
    assert.equal(p.summary.averageRmRating, 7, "single RM rating; not divided by all cells");
    assert.equal(p.rows.find((r) => cell(r) === "so2|2026-09-28")?.selfRating, null, "self rating hidden until finalized");
    assert.equal(p.summary.submittedReports, 2);
  }
  {
    const svc = loadService(makeFake().prisma);
    const p = await svc.getDailyPerformance(RM1, RANGE);
    assert.equal(p.summary.averageSelfRating, null, "no ratings → null (—)");
    assert.equal(p.summary.averageRmRating, null);
  }

  // 9) Admin State and SO filters are dependent, while RM's existing SO filter remains unchanged.
  {
    const svc = loadService(makeFake().prisma);
    const company = await svc.getDailyPerformance(ADMIN, RANGE);
    assert.deepEqual(company.officers.map((o) => o.id).sort(), ["so1", "so2", "so3", "so4", "so5"], "All States offers all SOs");

    const byOfficer = await svc.getDailyPerformance(ADMIN, { ...RANGE, officerId: "so3" });
    assert.deepEqual([...new Set(byOfficer.rows.map((r) => r.officerId))], ["so3"]);
    assert.deepEqual(byOfficer.officers.map((o) => o.id).sort(), ["so1", "so2", "so3", "so4", "so5"], "All States + specific SO keeps the company-wide option set");

    const mp = await svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g1" });
    assert.deepEqual([...new Set(mp.rows.map((r) => r.officerId))].sort(), ["so1", "so2"], "MP + All Sales Officers returns MP only");
    assert.deepEqual(mp.officers.map((o) => o.id).sort(), ["so1", "so2"], "MP dropdown contains MP SOs only");

    const byState = await svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g2" });
    assert.deepEqual([...new Set(byState.rows.map((r) => r.officerId))], ["so3"], "State filter → g2 only");
    assert.equal(byState.summary.salesOfficers, 1);
    assert.deepEqual(byState.officers.map((o) => o.id), ["so3"], "UP dropdown contains UP SOs only");

    const wb = await svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g3" });
    assert.deepEqual(wb.officers.map((o) => o.id), ["so4"], "WB dropdown contains WB SOs only");
    assert.deepEqual([...new Set(wb.rows.map((r) => r.officerId))], ["so4"], "WB + All Sales Officers returns WB only");

    const cg = await svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g4" });
    assert.deepEqual(cg.officers.map((o) => o.id), ["so5"], "CG dropdown contains CG SOs only");
    assert.deepEqual([...new Set(cg.rows.map((r) => r.officerId))], ["so5"], "CG + All Sales Officers returns CG only");

    const oneMpOfficer = await svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g1", officerId: "so1" });
    assert.deepEqual([...new Set(oneMpOfficer.rows.map((r) => r.officerId))], ["so1"], "MP + MP SO returns that SO only");
    await expectStatus(() => svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g1", officerId: "so3" }), 403, "MP + UP SO is rejected server-side");

    assert.equal(byState.states.map((s) => s.name).sort().join("|"), "CG|MP|UP|WB", "state options span the whole company");
    const rmFilter = await svc.getDailyPerformance(RM1, { ...RANGE, officerId: "so2" });
    assert.deepEqual([...new Set(rmFilter.rows.map((r) => r.officerId))], ["so2"]);
  }

  // 9b) Admin UI order and dependent-state behavior: Date From, Date To, State, then Sales Officer.
  {
    const page = readFileSync(resolve("src/features/daily-work/performance-page.tsx"), "utf8");
    const fromAt = page.indexOf("<Label>{L.dateFrom}</Label>");
    const toAt = page.indexOf("<Label>{L.dateTo}</Label>");
    const stateAt = page.indexOf("<Label>{L.fState}</Label>");
    const officerAt = page.indexOf("<Label>{L.officerLabel}</Label>");
    assert.ok(fromAt < toAt && toAt < stateAt && stateAt < officerAt, "Admin filters render Date From → Date To → State → Sales Officer");
    assert.ok(page.includes('useLabel("daily_work.performance.filter.all_sales_officers")'), "SO default uses All Sales Officers label");
    assert.ok(page.includes("isAdmin ? L.allSalesOfficers : L.allRms"), "the terminology change is limited to Admin; RM behavior stays unchanged");
    assert.ok(page.includes('setGroupId(value);') && page.includes('setOfficerId("");'), "State change resets the selected SO");
    assert.ok(page.includes("disabled={isAdmin && isFetching}"), "stale SO options are unavailable while the new State scope loads");
    const labels = localRequire(resolve("src/features/labels", "labels.ts")).DEFAULT_LABELS as Record<string, string>;
    assert.equal(labels["daily_work.performance.filter.all_sales_officers"], "All Sales Officers");
  }

  // 10) Detail authorization (403). Success paths are covered by the existing review-detail tests.
  {
    const svc = loadService(makeFake().prisma);
    await expectStatus(() => svc.getDailyWorkReviewDetail(SO1, "so2", "2026-09-28"), 403, "SO cannot view another SO's detail");
    await expectStatus(() => svc.getDailyWorkReviewDetail(RM2, "so1", "2026-09-28"), 403, "unrelated RM cannot view detail");
  }

  console.log("daily-performance.test.ts — all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
