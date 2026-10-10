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

interface Entry {
  officerId: string; date: string; section: string; rowKey?: string; status?: string; planSubmittedAt?: Date | null;
  id?: string; dealerId?: string | null; schemeId?: string | null; marketName?: string | null;
  typedDealerName?: string | null; todaysPlan?: number | null; todaysActual?: number | null; resultStatus?: string | null;
  dealerVisits?: number | null; newPartyVisits?: number | null; actualDealerVisits?: number | null; actualNewPartyVisits?: number | null;
}
interface Store {
  plans: Map<string, Date>;      // oid|date → earliest planSubmittedAt
  days: Map<string, { finalizedAt: Date | null; selfRating: number | null }>;
  reviews: Map<string, number>;  // oid|date → rm rating
  attendance: Map<string, string>;
  entries: Entry[];              // DailyWorkEntry rows (the section-total query)
  rawCount: number;              // # of $queryRaw calls (to assert N+1 boundedness)
}

function makeFake(init: Partial<Store> = {}) {
  const store: Store = {
    plans: init.plans ?? new Map(), days: init.days ?? new Map(),
    reviews: init.reviews ?? new Map(), attendance: init.attendance ?? new Map(), entries: init.entries ?? [], rawCount: 0,
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
    // Section totals: values = [...ids, from, to, summaryRowKey]. Emulates the query's WHERE (submitted rows only) and its day join.
    if (text.includes('FROM "DailyWorkEntry" e LEFT JOIN')) {
      const rowKey = v[v.length - 1] as string, to_ = v[v.length - 2] as string, from_ = v[v.length - 3] as string, ids_ = v.slice(0, v.length - 3) as string[];
      return store.entries
        .filter((e) => ids_.includes(e.officerId) && e.date >= from_ && e.date <= to_ && (e.planSubmittedAt === undefined ? true : e.planSubmittedAt !== null)
          && ["PLAN_SUBMITTED", "FINALIZED", "SUBMITTED"].includes(e.status ?? "PLAN_SUBMITTED")
          && ["SALES", "RECOVERY", "APPOINTMENT", "SCHEME_CONVERSION", "SUMMARY"].includes(e.section) && (e.section !== "SUMMARY" || (e.rowKey ?? "SUMMARY") === rowKey))
        .map((e) => ({
          id: e.id ?? `${e.officerId}-${e.date}-${e.section}`, officerId: e.officerId, workDate: D(e.date), dealerId: e.dealerId ?? null, schemeId: e.schemeId ?? null, marketName: e.marketName ?? null, entryType: "REGULAR", batchId: "b1",
          section: e.section, typedDealerName: e.typedDealerName ?? null, todaysPlan: e.todaysPlan == null ? null : String(e.todaysPlan), todaysActual: e.todaysActual == null ? null : String(e.todaysActual),
          resultStatus: e.resultStatus ?? null, dealerVisits: e.dealerVisits ?? null, newPartyVisits: e.newPartyVisits ?? null, actualDealerVisits: e.actualDealerVisits ?? null, actualNewPartyVisits: e.actualNewPartyVisits ?? null,
          reportFinalized: store.days.get(`${e.officerId}|${e.date}`)?.finalizedAt != null,
        }));
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
      findMany: async ({ where, select }: { where: { role?: Role | { in: Role[] }; id?: { in: string[] } }; select?: Record<string, unknown> }) =>
        USERS.filter((u) => (!where.role ? true : typeof where.role === "object" ? where.role.in.includes(u.role) : u.role === where.role)).filter((u) => (where.id?.in ? where.id.in.includes(u.id) : true))
          .map((u) => { const o: Record<string, unknown> = { id: u.id, name: u.name }; if (select?.role) o.role = u.role; if (select?.groupId) o.groupId = u.groupId; if (select?.group) o.group = u.groupId ? { id: u.groupId, name: GROUP_NAMES[u.groupId] } : null; return o; }),
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
const flat0 = (v: unknown) => JSON.parse(JSON.stringify(v));
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

  // 3) Admin sees all SOs across groups; N+1 GUARD: exactly 5 batched range queries regardless of officers×days.
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    const p = await svc.getDailyPerformance(ADMIN, RANGE);
    assert.deepEqual([...new Set(p.rows.map((r) => r.officerId))].sort(), ["rm1", "rm2", "so1", "so2", "so3", "so4", "so5"], "Admin sees every Daily Work owner: Sales Officers AND Regional Managers");
    assert.equal(p.rows.length, 21, "7 performers × 3 days");
    assert.equal(f.store.rawCount, 5, "fixed 5 batched range queries (incl. the one section-totals query) — no N+1");
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

  // 7b) The three milestones: nothing → plan only → plan + report. View ("submitted") follows the PLAN, not the report.
  {
    const plan = TS("2026-09-28T09:15:00.000Z");
    const report = TS("2026-09-28T18:30:00.000Z");
    const f = makeFake({
      plans: new Map([["so1|2026-09-28", plan], ["so1|2026-09-29", plan]]),
      days: new Map([["so1|2026-09-29", { finalizedAt: report, selfRating: 9 }]]),
    });
    const svc = loadService(f.prisma);
    const rows = (await svc.getDailyPerformance(SO1, RANGE)).rows;
    const by = (d: string) => rows.find((r) => r.date === d)!;
    const none = by("2026-09-27"), planOnly = by("2026-09-28"), both = by("2026-09-29");
    assert.deepEqual([none.planSubmittedAt, none.reportSubmittedAt, none.submitted], [null, null, false], "before anything: — / — / no View");
    assert.deepEqual([planOnly.planSubmittedAt, planOnly.reportSubmittedAt, planOnly.submitted], [plan.toISOString(), null, true], "plan submitted: timestamp / — / View");
    assert.deepEqual([planOnly.selfRating, planOnly.rmRating], [null, null], "no fabricated ratings on a plan-only day");
    assert.deepEqual([both.planSubmittedAt, both.reportSubmittedAt, both.submitted], [plan.toISOString(), report.toISOString(), true], "report submitted: both timestamps / View");
    assert.equal(both.selfRating, 9);
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
    assert.deepEqual(company.officers.map((o) => o.id).sort(), ["rm1", "rm2", "so1", "so2", "so3", "so4", "so5"], "All States offers every performer (SOs and RMs)");

    const byOfficer = await svc.getDailyPerformance(ADMIN, { ...RANGE, officerId: "so3" });
    assert.deepEqual([...new Set(byOfficer.rows.map((r) => r.officerId))], ["so3"]);
    assert.deepEqual(byOfficer.officers.map((o) => o.id).sort(), ["rm1", "rm2", "so1", "so2", "so3", "so4", "so5"], "All States + specific SO keeps the company-wide option set");

    const mp = await svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g1" });
    assert.deepEqual([...new Set(mp.rows.map((r) => r.officerId))].sort(), ["rm1", "so1", "so2"], "MP + All returns MP only (its RM included)");
    assert.deepEqual(mp.officers.map((o) => o.id).sort(), ["rm1", "so1", "so2"], "MP dropdown contains MP performers only");

    const byState = await svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g2" });
    assert.deepEqual([...new Set(byState.rows.map((r) => r.officerId))].sort(), ["rm2", "so3"], "State filter → g2 only");
    assert.equal(byState.summary.salesOfficers, 2);
    assert.deepEqual(byState.officers.map((o) => o.id).sort(), ["rm2", "so3"], "UP dropdown contains UP performers only");

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

  // 9b) UI: the Sales Officer COLUMN HEADER is the filter (shared ColumnFilterHeader); State stays above and resets it.
  {
    const page = readFileSync(resolve("src/features/daily-work/performance-page.tsx"), "utf8");
    const fromAt = page.indexOf("<Label>{L.dateFrom}</Label>");
    const toAt = page.indexOf("<Label>{L.dateTo}</Label>");
    const stateAt = page.indexOf("<Label>{L.fState}</Label>");
    assert.ok(fromAt < toAt && toAt < stateAt, "Date From → Date To → State filters remain");
    assert.ok(!page.includes("<Label>{L.officerLabel}</Label>"), "the separate Sales Officer dropdown above the table is gone");
    assert.ok(/<ColumnFilterHeader[^>]*label=\{L\.colOfficer\}/s.test(page), "Sales Officer header is a ColumnFilterHeader");
    assert.ok(page.includes("options={(data?.officers ?? []).map((o) => ({ value: o.id, label: o.name }))}"), "options come from the server's scoped list");
    assert.ok(page.includes("setOfficerId(next.find((id) => id !== officerId) ?? \"\")"), "single selection: a new tick replaces, untick clears");
    assert.ok(page.includes('setGroupId(value);') && page.includes('setOfficerId("");'), "State change clears the selected person");
    assert.ok(page.includes("if (!isSO && officerId) query.set(\"officerId\", officerId)") && page.includes("query.set(\"groupId\", groupId)"), "the selection travels to the server with State and the date range");
    assert.ok(page.includes("const showOfficer = !isSO"), "Sales Officers never get the person filter");
  }

  // 9c) Regional Managers are Daily Work owners and appear in Performance like Sales Officers.
  {
    const plan = TS("2026-09-28T09:15:00.000Z"), report = TS("2026-09-28T18:30:00.000Z");
    const f = makeFake({
      plans: new Map([["rm2|2026-09-28", plan], ["so3|2026-09-28", plan], ["rm2|2026-10-09", plan]]),
      days: new Map([["rm2|2026-09-28", { finalizedAt: report, selfRating: 9 }]]),
      attendance: new Map([["rm2|2026-09-29", "LEAVE"]]),
    });
    const svc = loadService(f.prisma);
    const all = await svc.getDailyPerformance(ADMIN, RANGE);
    const rm = (d: string) => all.rows.find((r) => r.officerId === "rm2" && r.date === d)!;
    assert.deepEqual([rm("2026-09-28").planSubmittedAt, rm("2026-09-28").reportSubmittedAt, rm("2026-09-28").submitted], [plan.toISOString(), report.toISOString(), true], "RM plan + report submission");
    assert.equal(rm("2026-09-28").selfRating, 9, "RM self rating");
    assert.equal(rm("2026-09-28").stateName, "UP", "RM state is its group");
    assert.equal(rm("2026-09-29").attendance, "LEAVE", "RM attendance override");
    assert.equal(rm("2026-09-27").attendance, "PRESENT", "RM attendance defaults to Present");
    assert.ok(!all.rows.some((r) => r.officerId === "rm2" && r.date === "2026-10-09"), "RM record outside the date range is excluded");
    const keys = all.rows.map((r) => `${r.officerId}|${r.date}`);
    assert.equal(new Set(keys).size, keys.length, "no performer-day is counted twice");
    assert.equal(all.summary.salesOfficers, 7);
    assert.equal(all.summary.submittedPlans, 2, "rm2 + so3 on the 28th (the out-of-range plan is not counted)");
    assert.equal(all.summary.submittedReports, 1);
    assert.equal(all.summary.averageSelfRating, 9);

    // State + person filters work for an RM exactly like an SO; a person from another State is rejected.
    const up = await svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g2" });
    assert.deepEqual([...new Set(up.rows.map((r) => r.officerId))].sort(), ["rm2", "so3"]);
    const justRm = await svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g2", officerId: "rm2" });
    assert.deepEqual([...new Set(justRm.rows.map((r) => r.officerId))], ["rm2"]);
    assert.equal(justRm.summary.salesOfficers, 1);
    assert.equal(justRm.summary.submittedReports, 1, "summary follows the selected person");
    await expectStatus(() => svc.getDailyPerformance(ADMIN, { ...RANGE, groupId: "g1", officerId: "rm2" }), 403, "an RM from another State is not selectable");

    // Authorization: an RM caller still sees only the Sales Officers of their own team (never RMs / other teams); an SO only self.
    const asRm = await svc.getDailyPerformance(RM2, RANGE);
    assert.deepEqual([...new Set(asRm.rows.map((r) => r.officerId))], ["so3"], "RM sees their team only — unchanged");
    assert.deepEqual(asRm.officers.map((o) => o.id), ["so3"]);
    await expectStatus(() => svc.getDailyPerformance(RM2, { ...RANGE, officerId: "rm1" }), 403, "another RM is not exposed through the filter");
    assert.deepEqual([...new Set((await svc.getDailyPerformance(SO1, RANGE)).rows.map((r) => r.officerId))], ["so1"]);

    // Attendance of an RM can be set by Admin (like an SO) and persists; other roles still cannot.
    await svc.setDailyWorkAttendance(ADMIN, { officerId: "rm2", workDate: "2026-09-27", status: "ABSENT" });
    assert.equal((await svc.getDailyPerformance(ADMIN, { ...RANGE, officerId: "rm2" })).rows.find((r) => r.date === "2026-09-27")?.attendance, "ABSENT");
    await expectStatus(() => svc.setDailyWorkAttendance(RM1, { officerId: "rm1", workDate: "2026-09-27", status: "ABSENT" }), 403, "an RM cannot set attendance");
    await expectStatus(() => svc.setDailyWorkAttendance(ADMIN, { officerId: "admin", workDate: "2026-09-27", status: "ABSENT" }), 422, "non Daily-Work users are still refused");
  }

  // 9d) "Missed" is DERIVED: plan submitted + report not finalized + noon deadline passed. Nothing is stored or faked.
  {
    const plan = TS("2026-09-28T09:15:00.000Z"), report = TS("2026-09-28T13:00:00.000Z");
    const lib = localRequire(resolve("src/lib", "daily-work.ts")) as typeof import("@/lib/daily-work");
    const f = makeFake({
      plans: new Map([["so1|2026-09-28", plan], ["so1|2026-09-29", plan], ["rm2|2026-09-28", plan], ["so3|2026-09-28", plan]]),
      days: new Map([["so3|2026-09-28", { finalizedAt: report, selfRating: 8 }]]),
    });
    const svc = loadService(f.prisma);
    const missed = async (id: string, date: string) => (await svc.getDailyPerformance(ADMIN, { from: date, to: date, officerId: id })).rows[0]!;
    // Before the deadline (29 Sep 12:00 IST) a missing report is still pending, not Missed.
    lib.dailyWorkClock.now = () => new Date("2026-09-29T11:59:00+05:30");
    assert.equal((await missed("so1", "2026-09-28")).reportMissed, false, "not Missed before the deadline");
    lib.dailyWorkClock.now = () => new Date("2026-09-29T12:00:00.000+05:30");
    assert.equal((await missed("so1", "2026-09-28")).reportMissed, false, "exactly noon is still on time");
    // After the deadline: Missed — for SOs and RMs alike — with NO fake submission data.
    lib.dailyWorkClock.now = () => new Date("2026-09-29T12:01:00+05:30");
    for (const id of ["so1", "rm2"]) {
      const row = await missed(id, "2026-09-28");
      assert.equal(row.reportMissed, true, `${id} report is Missed after the deadline`);
      assert.deepEqual([row.reportSubmittedAt, row.selfRating, row.rmRating, row.planSubmittedAt != null], [null, null, null, true], "no timestamp, no self/RM rating; the plan is unaffected");
    }
    const done = await missed("so3", "2026-09-28");
    assert.deepEqual([done.reportMissed, done.reportSubmittedAt, done.selfRating], [false, report.toISOString(), 8], "a finalized report never becomes Missed");
    assert.equal((await missed("so1", "2026-09-27")).reportMissed, false, "a day with no plan is never Missed");
    assert.equal((await missed("so1", "2026-09-29")).reportMissed, false, "today's report is not Missed while its window is open");
    assert.equal(f.store.days.has("so1|2026-09-28"), false, "no DailyWorkDay / submission record was created for the Missed day");
    assert.equal(f.store.reviews.size, 0, "no RM review exists for a Missed day");
    lib.dailyWorkClock.now = () => new Date();
  }

  // 10) Detail authorization (403). Success paths are covered by the existing review-detail tests.
  {
    const svc = loadService(makeFake().prisma);
    await expectStatus(() => svc.getDailyWorkReviewDetail(SO1, "so2", "2026-09-28"), 403, "SO cannot view another SO's detail");
    await expectStatus(() => svc.getDailyWorkReviewDetail(RM2, "so1", "2026-09-28"), 403, "unrelated RM cannot view detail");
  }

  // 11) Section Planned / Actual totals (Sales, Recovery, Scheme Conversion, Appointment, Visits) follow the table's filters.
  {
    const FIN = { finalizedAt: TS("2026-09-28T12:00:00Z"), selfRating: 7 };
    const E = (officerId: string, date: string, section: string, o: Partial<Entry> = {}): Entry => ({ officerId, date, section, ...o });
    const entries: Entry[] = [
      // so1 (MP) 28th — finalized day
      E("so1", "2026-09-28", "SALES", { todaysPlan: 1000, todaysActual: 800 }), E("so1", "2026-09-28", "SALES", { todaysPlan: 500, todaysActual: null }),
      E("so1", "2026-09-28", "RECOVERY", { todaysPlan: 300, todaysActual: 0 }), E("so1", "2026-09-28", "RECOVERY", { todaysPlan: 200, todaysActual: -50 }),
      E("so1", "2026-09-28", "SCHEME_CONVERSION", { todaysPlan: 4, resultStatus: "YES" }), E("so1", "2026-09-28", "SCHEME_CONVERSION", { todaysPlan: 2, resultStatus: "NO" }), E("so1", "2026-09-28", "SCHEME_CONVERSION", { todaysPlan: 3, resultStatus: null }),
      E("so1", "2026-09-28", "APPOINTMENT", { typedDealerName: "A", resultStatus: "APPOINTED" }), E("so1", "2026-09-28", "APPOINTMENT", { typedDealerName: "B", resultStatus: "NOT_APPOINTED" }), E("so1", "2026-09-28", "APPOINTMENT", { typedDealerName: "  ", resultStatus: "APPOINTED" }),
      E("so1", "2026-09-28", "SUMMARY", { rowKey: "SUMMARY", dealerVisits: 3, newPartyVisits: 2, actualDealerVisits: 2, actualNewPartyVisits: 1 }),
      E("so1", "2026-09-28", "SUMMARY", { rowKey: "SUMMARY", dealerVisits: 1, newPartyVisits: null, actualDealerVisits: null, actualNewPartyVisits: 4 }), // 2nd batch of the same day
      E("so1", "2026-09-28", "OTHERS", { todaysPlan: 99999, todaysActual: 99999 }), // Others never totalled
      E("so1", "2026-09-28", "SALES", { todaysPlan: 7777, todaysActual: 7777, status: "DRAFT", planSubmittedAt: null }), // draft: never counted
      // so1 29th — plan submitted, report NOT finalized (missing report): planned counts, actual does not
      E("so1", "2026-09-29", "SALES", { todaysPlan: 2000, todaysActual: 1500 }), E("so1", "2026-09-29", "SUMMARY", { rowKey: "SUMMARY", dealerVisits: 5, newPartyVisits: 5, actualDealerVisits: 9, actualNewPartyVisits: 9 }),
      // so3 (UP) 28th — finalized
      E("so3", "2026-09-28", "SALES", { todaysPlan: 4000, todaysActual: 3500 }), E("so3", "2026-09-28", "APPOINTMENT", { typedDealerName: "C", resultStatus: "APPOINTED" }),
      // so2 (MP) 27th
      E("so2", "2026-09-27", "SALES", { todaysPlan: 100, todaysActual: 90 }),
      // so1 on 1 Oct: outside the 27–29 range
      E("so1", "2026-10-01", "SALES", { todaysPlan: 55555, todaysActual: 55555 }),
    ];
    const days = new Map([["so1|2026-09-28", FIN], ["so3|2026-09-28", FIN], ["so2|2026-09-27", { finalizedAt: TS("2026-09-27T12:00:00Z"), selfRating: 5 }], ["so1|2026-10-01", FIN]]);
    const run = (ctx: AuthContext, filters: Record<string, string> = {}) => { const f = makeFake({ entries, days }); return loadService(f.prisma).getDailyPerformance(ctx, { ...RANGE, ...filters }).then((p) => ({ p, f })); };
    const flat = (t: unknown) => JSON.parse(JSON.stringify(t));

    // so1 alone, 28th only: every section, each rule.
    const one = (await run(SO1, { from: "2026-09-28", to: "2026-09-28" })).p.summary.sections;
    assert.deepEqual(flat(one), {
      sales: { planned: 1500, actual: 800 },                  // draft row excluded; the missing actual adds 0
      recovery: { planned: 500, actual: -50 },                // explicit 0 and a negative adjustment are summed as entered
      schemeConversion: { planned: 9, actual: 4 },            // units; actual = units reported YES (NO / not reported are not converted)
      appointment: { planned: 2, actual: 1 },                 // the unnamed placeholder row is not a planned appointment; counts, not rupees
      visits: { planned: 6, actual: 7 },                      // both batches of the day, null treated as nothing (not as completed work)
    }, "per-section Planned and Actual for one officer-day");

    // Missing report: planned counts, actual does not (29th is not finalized).
    const missing = (await run(SO1, { from: "2026-09-29", to: "2026-09-29" })).p.summary.sections;
    assert.deepEqual(flat(missing), { sales: { planned: 2000, actual: 0 }, recovery: { planned: 0, actual: 0 }, schemeConversion: { planned: 0, actual: 0 }, appointment: { planned: 0, actual: 0 }, visits: { planned: 10, actual: 0 } }, "an unfinalized report contributes no actuals");

    // Date range: From/To are inclusive; rows outside never leak in.
    const range = (await run(SO1)).p.summary.sections;
    assert.equal(range.sales.planned, 3500, "28th + 29th, not 1 Oct");
    assert.equal(range.sales.actual, 800);
    assert.equal((await run(SO1, { from: "2026-09-28", to: "2026-09-28" })).p.summary.sections.sales.planned, 1500, "changing To recalculates");
    assert.equal((await run(SO1, { from: "2026-10-01", to: "2026-10-01" })).p.summary.sections.sales.planned, 55555, "a different range gives its own totals");
    assert.equal((await run(SO1, { from: "2026-09-26", to: "2026-09-26" })).p.summary.sections.sales.planned, 0, "no work in range → zeros, not company data");

    // Admin: company-wide, then State filter narrows the totals AND the rows together; date + State combined.
    const all = await run(ADMIN);
    assert.equal(all.p.summary.sections.sales.planned, 1500 + 2000 + 4000 + 100, "multiple officers across states");
    assert.equal(all.p.summary.sections.sales.actual, 800 + 3500 + 90, "actuals only from finalized days");
    assert.equal(all.p.summary.sections.appointment.actual, 2, "so1's A and so3's C");
    const mp = await run(ADMIN, { groupId: "g1" });
    assert.deepEqual([...new Set(mp.p.rows.map((r) => r.officerId))].sort(), ["rm1", "so1", "so2"]);
    assert.equal(mp.p.summary.sections.sales.planned, 1500 + 2000 + 100, "State=MP excludes UP's 4000 — the cards never show company-wide totals under a State filter");
    const up = await run(ADMIN, { groupId: "g2" });
    assert.deepEqual(flat(up.p.summary.sections.sales), { planned: 4000, actual: 3500 });
    assert.equal(up.p.summary.sections.visits.planned, 0);
    assert.equal((await run(ADMIN, { groupId: "g1", from: "2026-09-28", to: "2026-09-28" })).p.summary.sections.sales.planned, 1500, "State + date range together");
    assert.equal((await run(ADMIN, { groupId: "g1", officerId: "so2" })).p.summary.sections.sales.planned, 100, "officer filter inside a State");

    // Totals come from the same population as the table rows, over ALL rows (no paging).
    const expected = entries.filter((e) => e.section === "SALES" && e.status !== "DRAFT" && mp.p.rows.some((r) => r.officerId === e.officerId && r.date === e.date)).reduce((s, e) => s + (e.todaysPlan ?? 0), 0);
    assert.equal(mp.p.summary.sections.sales.planned, expected, "summary and table share one filter set");

    // Authorization / scope: RM only their team, SO only themself (spoofed officer ignored), unrelated RM sees none.
    assert.equal((await run(RM1)).p.summary.sections.sales.planned, 1500 + 2000 + 100, "RM sees g1 only");
    assert.equal((await run(RM2)).p.summary.sections.sales.planned, 4000, "the other RM sees only their own team");
    assert.equal((await run(SO1, { officerId: "so2" })).p.summary.sections.sales.planned, 3500, "an SO's totals are their own even when another officer is requested");
    await expectStatus(() => run(RM1, { officerId: "so3" }), 403, "RM cannot total another team's officer");
    assert.deepEqual(flat((await run(RM2, { from: "2026-09-26", to: "2026-09-26" })).p.summary.sections.sales), { planned: 0, actual: 0 });
    assert.equal(all.f.store.rawCount, 5, "one totals query regardless of officers/days");

    // Existing summary metrics are unchanged by the new section totals.
    assert.equal(all.p.summary.salesOfficers, 7); assert.equal(all.p.summary.totalDays, 21);
  }

  // 12) The page: ten new cards (no Others), money vs count formats, existing cards kept.
  {
    const page = readFileSync(resolve("src/features/daily-work/performance-page.tsx"), "utf8");
    for (const k of ["sales", "recovery", "scheme_conversion", "appointment", "visits"]) for (const w of ["planned", "actual"]) assert.ok(page.includes(`daily_work.performance.summary.${k}_${w}`), `${k} ${w} card`);
    assert.ok(!/others_(planned|actual)/.test(page) && !page.includes("sections.others"), "no totals for Others");
    assert.ok(page.includes('[L.sSalesP, L.sSalesA, "sales", rupees, "sales"]') && page.includes('[L.sRecoveryP, L.sRecoveryA, "recovery", rupees, "recovery"]') && page.includes('"schemeConversion", countText') && page.includes('"appointment", countText') && page.includes('"visits", countText'), "Sales/Recovery in rupees; the others as counts/units");
    for (const old of ["sOfficers", "sAttendance", "sPlans", "sReports", "sAvgSelf", "sAvgRm"]) assert.ok(page.includes(`label={L.${old}}`), `existing card ${old} kept`);
    assert.ok(page.includes('queryKey: ["performance", role, from, to, officerId, groupId]'), "cards refetch whenever Date From / Date To / State change");
    const svc = readFileSync(resolve("src/features/daily-work/service.server.ts"), "utf8");
    assert.ok(svc.includes(`e."planSubmittedAt" IS NOT NULL AND e."status" IN ('PLAN_SUBMITTED','FINALIZED','SUBMITTED')`) && svc.includes('e."officerId" IN (${Prisma.join(ids)}) AND e."workDate" BETWEEN ${from}::date AND ${to}::date'), "totals query: submitted rows of the filtered officers and dates only");
  }

  // 13) Summary-card drill-down: the records behind each of the ten metrics reconcile EXACTLY with the summary, under the same filters and scope.
  {
    const FIN = { finalizedAt: TS("2026-09-28T12:00:00Z"), selfRating: 7 };
    const E = (id: string, officerId: string, date: string, section: string, o: Partial<Entry> = {}): Entry => ({ id, officerId, date, section, ...o });
    const entries: Entry[] = [
      E("s1", "so1", "2026-09-28", "SALES", { dealerId: "d1", todaysPlan: 1000, todaysActual: 800 }), E("s2", "so1", "2026-09-28", "SALES", { dealerId: "d2", todaysPlan: 500, todaysActual: null }),
      E("s3", "so1", "2026-09-28", "SALES", { dealerId: "d1", todaysPlan: 7777, todaysActual: 7777, status: "DRAFT", planSubmittedAt: null }),
      E("s4", "so1", "2026-09-29", "SALES", { dealerId: "d2", todaysPlan: 2000, todaysActual: 1500 }), // report not finalized
      E("s5", "so3", "2026-09-28", "SALES", { dealerId: "d3", todaysPlan: 4000, todaysActual: 3500 }),
      E("r1", "so1", "2026-09-28", "RECOVERY", { dealerId: "d1", todaysPlan: 300, todaysActual: 0 }), E("r2", "so1", "2026-09-28", "RECOVERY", { dealerId: "d2", todaysPlan: 200, todaysActual: -50 }),
      E("c1", "so1", "2026-09-28", "SCHEME_CONVERSION", { dealerId: "d1", schemeId: "sch1", todaysPlan: 4, resultStatus: "YES" }), E("c2", "so1", "2026-09-28", "SCHEME_CONVERSION", { dealerId: "d2", schemeId: "sch1", todaysPlan: 2, resultStatus: "NO" }),
      E("a1", "so1", "2026-09-28", "APPOINTMENT", { typedDealerName: "Alpha", marketName: "Indore", resultStatus: "APPOINTED" }), E("a2", "so1", "2026-09-28", "APPOINTMENT", { typedDealerName: "Beta", marketName: "Bhopal", resultStatus: "NOT_APPOINTED" }),
      E("a3", "so1", "2026-09-28", "APPOINTMENT", { typedDealerName: " ", resultStatus: "APPOINTED" }), E("a4", "so3", "2026-09-28", "APPOINTMENT", { typedDealerName: "Gamma", marketName: "Agra", resultStatus: "APPOINTED" }),
      E("v1", "so1", "2026-09-28", "SUMMARY", { rowKey: "SUMMARY", dealerVisits: 3, newPartyVisits: 2, actualDealerVisits: 2, actualNewPartyVisits: 1 }),
      E("v2", "so1", "2026-09-28", "SUMMARY", { rowKey: "SUMMARY", dealerVisits: null, newPartyVisits: null, actualDealerVisits: null, actualNewPartyVisits: null }), // an Others-only save: no visits entered
      E("v3", "so1", "2026-09-29", "SUMMARY", { rowKey: "SUMMARY", dealerVisits: 5, newPartyVisits: 5, actualDealerVisits: 9, actualNewPartyVisits: 9 }),
      E("o1", "so1", "2026-09-28", "OTHERS", { todaysPlan: 99999 }),
      E("s6", "so2", "2026-09-27", "SALES", { dealerId: "d1", todaysPlan: 100, todaysActual: 90 }),
      E("s7", "so1", "2026-10-01", "SALES", { dealerId: "d1", todaysPlan: 55555, todaysActual: 55555 }),
    ];
    const days = new Map([["so1|2026-09-28", FIN], ["so3|2026-09-28", FIN], ["so2|2026-09-27", { finalizedAt: TS("2026-09-27T12:00:00Z"), selfRating: 5 }], ["so1|2026-10-01", FIN]]);
    const f0 = makeFake({ entries, days });
    (f0.prisma as Record<string, unknown>).dealer = { findMany: async ({ where }: { where: { id: { in: string[] } } }) => [{ id: "d1", name: "Dealer One" }, { id: "d2", name: "Dealer Two" }, { id: "d3", name: "Dealer Three" }].filter((d) => where.id.in.includes(d.id)) };
    (f0.prisma as Record<string, unknown>).scheme = { findMany: async () => [{ id: "sch1", schemeName: "Monsoon Offer" }] };
    const svc = loadService(f0.prisma);
    const detail = (ctx: AuthContext, input: Record<string, unknown>) => svc.getPerformanceMetricDetail(ctx, { ...RANGE, ...input });
    const summary = async (ctx: AuthContext, filters: Record<string, string> = {}) => (await svc.getDailyPerformance(ctx, { ...RANGE, ...filters })).summary.sections;
    const flat = (t: unknown) => JSON.parse(JSON.stringify(t));
    const METRICS = [["sales", "SALES"], ["recovery", "RECOVERY"], ["scheme_conversion", "SCHEME_CONVERSION"], ["appointment", "APPOINTMENT"], ["visits", "SUMMARY"]] as const;
    const KEY: Record<string, "sales" | "recovery" | "schemeConversion" | "appointment" | "visits"> = { sales: "sales", recovery: "recovery", scheme_conversion: "schemeConversion", appointment: "appointment", visits: "visits" };

    // Every one of the ten metrics: the listed records add up EXACTLY to the summary card, for several scopes / filters.
    const scopes: [string, AuthContext, Record<string, string>][] = [
      ["admin company", ADMIN, {}], ["admin State=MP", ADMIN, { groupId: "g1" }], ["admin State=UP", ADMIN, { groupId: "g2" }], ["admin one day", ADMIN, { from: "2026-09-28", to: "2026-09-28" }],
      ["admin MP one day", ADMIN, { groupId: "g1", from: "2026-09-28", to: "2026-09-28" }], ["admin one officer", ADMIN, { officerId: "so3" }], ["RM1", RM1, {}], ["SO1", SO1, {}], ["empty range", ADMIN, { from: "2026-09-20", to: "2026-09-20" }],
    ];
    for (const [name, ctx, filters] of scopes) {
      const sum = await summary(ctx, filters);
      for (const [id] of METRICS) for (const kind of ["planned", "actual"] as const) {
        const d = await detail(ctx, { ...filters, metric: `${id}_${kind}`, pageSize: 100 });
        assert.equal(d.total, sum[KEY[id]][kind], `${name}: ${id}_${kind} detail total = summary card`);
        assert.equal(d.kind, kind);
        assert.equal(Math.round(d.rows.reduce((s, r) => s + r.value, 0) * 100) / 100, d.total, `${name}: ${id}_${kind} the listed rows add up to the total`);
        assert.equal(d.recordCount, d.rows.length, `${name}: ${id}_${kind} record count`);
        assert.equal(d.employeeCount, new Set(d.rows.map((r) => r.officerId)).size);
      }
    }

    // Attribution, sources and record identifiers (nothing invented).
    const salesA = await detail(ADMIN, { metric: "sales_actual", pageSize: 100 });
    assert.deepEqual(flat(salesA.rows.map((r) => [r.entryId, r.employeeName, r.date, r.record, r.value]).sort()), [["s1", "Rahul", "2026-09-28", "Dealer One", 800], ["s5", "Ravi", "2026-09-28", "Dealer Three", 3500], ["s6", "Amit", "2026-09-27", "Dealer One", 90]],
      "Sales Actual: finalized reports only; the missing actual (s2), the unfinalized day (s4), drafts and out-of-range rows are not listed");
    assert.equal(salesA.rows.find((r) => r.entryId === "s1")!.stateName, "MP"); assert.equal(salesA.rows.find((r) => r.entryId === "s5")!.stateName, "UP");
    assert.ok(salesA.rows.every((r) => r.reportFinalized && r.role === Role.SALES_OFFICER));
    const salesP = await detail(ADMIN, { metric: "sales_planned", pageSize: 100 });
    assert.deepEqual(flat(salesP.rows.map((r) => r.entryId).sort()), ["s1", "s2", "s4", "s5", "s6"], "Sales Planned lists submitted plans (incl. the unfinalized day), never the draft");
    assert.equal(salesP.rows.find((r) => r.entryId === "s4")!.reportFinalized, false);
    assert.deepEqual(flat((await detail(ADMIN, { metric: "recovery_actual" })).rows.map((r) => [r.entryId, r.value]).sort()), [["r1", 0], ["r2", -50]], "an explicit 0 and a negative adjustment are listed as entered");
    const conv = await detail(ADMIN, { metric: "scheme_conversion_actual" });
    assert.deepEqual(flat(conv.rows.map((r) => [r.entryId, r.value, r.record, r.recordDetail])), [["c1", 4, "Dealer One", "Monsoon Offer"]], "Scheme Conversion Actual: only the rows reported YES, with dealer and scheme");
    assert.equal((await detail(ADMIN, { metric: "scheme_conversion_planned" })).total, 6);
    const apptA = await detail(ADMIN, { metric: "appointment_actual" });
    assert.deepEqual(flat(apptA.rows.map((r) => [r.entryId, r.record, r.recordDetail, r.value]).sort()), [["a1", "Alpha", "Indore", 1], ["a4", "Gamma", "Agra", 1]], "Appointments: named dealers only, counted as 1 each");
    assert.equal((await detail(ADMIN, { metric: "appointment_planned" })).recordCount, 3);
    const visitsA = await detail(ADMIN, { metric: "visits_actual" });
    assert.deepEqual(flat(visitsA.rows.map((r) => [r.entryId, r.value, r.visitParts])), [["v1", 3, { dealer: 2, newParty: 1 }]], "Visits Actual: the finalized day; the 29th (unfinalized) and the empty Others-only row are not listed");
    assert.deepEqual(flat((await detail(ADMIN, { metric: "visits_planned" })).rows.map((r) => [r.entryId, r.value]).sort()), [["v1", 5], ["v3", 10]]);

    // Date range + State filters are respected and echoed.
    const mp = await detail(ADMIN, { metric: "sales_planned", groupId: "g1", from: "2026-09-28", to: "2026-09-28" });
    assert.deepEqual(flat(mp.rows.map((r) => r.entryId).sort()), ["s1", "s2"]);
    assert.equal(mp.stateName, "MP"); assert.equal(mp.from, "2026-09-28"); assert.equal(mp.to, "2026-09-28");
    assert.equal((await detail(ADMIN, { metric: "sales_planned" })).stateName, null, "All States");
    assert.equal((await detail(ADMIN, { metric: "sales_planned", groupId: "g2" })).total, 4000, "State=UP never includes MP's plans");

    // Empty results.
    const none = await detail(ADMIN, { metric: "sales_actual", from: "2026-09-20", to: "2026-09-20" });
    assert.deepEqual([none.total, none.recordCount, none.employeeCount, none.rows.length, none.totalPages], [0, 0, 0, 0, 1]);

    // Pagination never changes the overall total / counts; pages are disjoint and complete; sorting works.
    const p1 = await detail(ADMIN, { metric: "sales_planned", pageSize: 2, page: 1, sort: "value", dir: "desc" });
    const p2 = await detail(ADMIN, { metric: "sales_planned", pageSize: 2, page: 2, sort: "value", dir: "desc" });
    const p3 = await detail(ADMIN, { metric: "sales_planned", pageSize: 2, page: 3, sort: "value", dir: "desc" });
    assert.deepEqual([p1.total, p2.total, p3.total], [salesP.total, salesP.total, salesP.total], "total covers all matching records, not the page");
    assert.deepEqual([p1.recordCount, p1.totalPages, p1.rows.length, p2.rows.length, p3.rows.length], [5, 3, 2, 2, 1]);
    assert.deepEqual(flat([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.entryId)), ["s5", "s4", "s1", "s2", "s6"], "value-descending, no overlap, nothing missing");
    assert.equal((await detail(ADMIN, { metric: "sales_planned", pageSize: 2, page: 99 })).page, 3, "page is clamped");
    assert.deepEqual(flat((await detail(ADMIN, { metric: "sales_planned", sort: "employee", dir: "asc", pageSize: 100 })).rows.map((r) => r.employeeName)), ["Amit", "Rahul", "Rahul", "Rahul", "Ravi"]);
    assert.deepEqual(flat((await detail(ADMIN, { metric: "sales_planned", sort: "date", dir: "asc", pageSize: 100 })).rows.map((r) => r.date)), ["2026-09-27", "2026-09-28", "2026-09-28", "2026-09-28", "2026-09-29"]);
    assert.equal((await detail(ADMIN, { metric: "sales_planned", pageSize: 9999 })).pageSize, 100, "page size is capped");

    // Authorization: nothing outside the caller's scope is listed or revealed.
    const rmList = await detail(RM1, { metric: "sales_planned", pageSize: 100 });
    assert.ok(rmList.rows.every((r) => ["so1", "so2"].includes(r.officerId)) && rmList.total === 1000 + 500 + 2000 + 100, "RM: own team only");
    const soList = await detail(SO1, { metric: "sales_planned", officerId: "so2", pageSize: 100 });
    assert.ok(soList.rows.every((r) => r.officerId === "so1"), "an SO only ever sees their own records, even when another officer is requested");
    await expectStatus(() => detail(RM1, { metric: "sales_planned", officerId: "so3" }), 403, "RM cannot drill into another team's officer");
    await expectStatus(() => detail(RM2, { metric: "sales_planned", officerId: "so1" }), 403, "an unrelated RM cannot either");
    assert.equal((await detail(RM2, { metric: "sales_planned" })).total, 4000);
    assert.ok(!JSON.stringify(await detail(RM2, { metric: "sales_planned" })).includes("Rahul"), "no data about officers outside the scope");
    await expectStatus(() => detail({ userId: "x", role: "NOBODY" as unknown as Role, username: "x", groupId: null } as AuthContext, { metric: "sales_planned" }), 403, "unknown role refused");

    // Invalid identifiers and ranges are rejected.
    for (const bad of [undefined, "", "sales", "others_planned", "sales_total", "SALES_PLANNED", "sales_planned; drop", 5]) await expectStatus(() => detail(ADMIN, { metric: bad }), 422, `invalid metric ${String(bad)}`);
    await expectStatus(() => detail(ADMIN, { metric: "sales_planned", from: "2026-09-29", to: "2026-09-28" }), 422, "From after To");
    await expectStatus(() => detail(ADMIN, { metric: "sales_planned", from: "2026-01-01", to: "2026-06-01" }), 422, "range over the limit");

    // Fixed queries: no per-row lookups (one entries query + two batched name lookups on the visible page).
    const f1 = makeFake({ entries, days }); (f1.prisma as Record<string, unknown>).dealer = (f0.prisma as Record<string, unknown>).dealer; (f1.prisma as Record<string, unknown>).scheme = (f0.prisma as Record<string, unknown>).scheme;
    await loadService(f1.prisma).getPerformanceMetricDetail(ADMIN, { ...RANGE, metric: "sales_planned", pageSize: 100 });
    assert.equal(f1.store.rawCount, 1, "one batched query for every contributing record");
  }

  // 14) The cards open the matching detail; the endpoint is permission-mapped and shares the summary's rules.
  {
    const page = readFileSync(resolve("src/features/daily-work/performance-page.tsx"), "utf8");
    assert.equal((page.match(/onOpen=\{data \? \(\) => setMetric\(\{ metric: `\$\{id\}_(planned|actual)`/g) ?? []).length, 2, "each pair's two cards open `<section>_planned` / `<section>_actual`");
    assert.ok(page.includes('"scheme_conversion"') && page.includes('"sales"') && page.includes('"recovery"') && page.includes('"appointment"') && page.includes('"visits"'), "ids for all five sections");
    assert.ok(page.includes("<button type=\"button\"") && page.includes("focus-visible:ring-2") && page.includes("cursor-pointer") && page.includes("hover:bg-muted/60"), "keyboard-accessible button with hover/focus state");
    assert.ok(page.includes("<PerformanceMetricDetail request={{ ...metric, from: data.from, to: data.to, officerId, groupId, isSO, isAdmin }"), "the drill-down inherits the page's filters");
    const modal = readFileSync(resolve("src/features/daily-work/performance-metric-detail.tsx"), "utf8");
    assert.ok(modal.includes("/api/daily-work/performance/detail?") && modal.includes("keepPreviousData") && modal.includes("data-testid=\"detail-total\"") && modal.includes("L.pageTotal") && modal.includes("L.grandTotal") && modal.includes("L.empty"), "total, page total, all-records total and empty state");
    assert.ok(!/<select|<NativeSelect|type="date"/.test(modal), "no independent filters in the detail view");
    const { apiPermission } = localRequire(resolve("src/features/accounts/route-permissions.ts")) as { apiPermission: (p: string, m: string) => unknown };
    assert.deepEqual(flat0(apiPermission("/api/daily-work/performance/detail", "GET")), ["performance", "read"]);
    assert.deepEqual(flat0(apiPermission("/api/daily-work/performance", "GET")), ["performance", "read"]);
    const route = readFileSync(resolve("src/app/api/daily-work/performance/detail/route.ts"), "utf8");
    assert.ok(route.includes("requireAuth()") && route.includes("getPerformanceMetricDetail(auth"), "authenticated; scope is enforced in the service");
  }

  console.log("daily-performance.test.ts — all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
