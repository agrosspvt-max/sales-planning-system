/**
 * Service-level contracts for Daily Work (Sales + Recovery), loading the real `service.server.ts` with a
 * DB-free fake. Proves the service:
 *   - sources current-month sales plan/actual and recovery plan/actual (never season totals),
 *   - derives Pending with the correct per-section formula,
 *   - scopes every dealer to the officer's assignment (unauthorized dealer → 403),
 *   - rejects duplicate dealer rows and invalid/absent scheme references,
 *   - persists Save Draft, flips to SUBMITTED on Submit,
 *   - allows Today's Actual only AFTER submission (before → 409).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Prisma, Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";
import { combineDailyWorkRows } from "@/lib/daily-work";
import { dailyWorkServiceInfrastructureMocks } from "./service-test-mocks";

/* ------------------------------- In-memory DailyWorkEntry store + Prisma fake ------------------------------- */

interface DW { id: string; officerId: string; dealerId: string; workDate: string; batchId?: string; section: string; todaysPlan: string | null; todaysActual: string | null; entryType: string; schemeId: string | null; status: string }

// Authoritative per-dealer sales input for the CURRENT month, mirroring getMonthly → buildMonthlyDealers:
// each product line has a monthly `plan` cell (a QUANTITY in PACK_SIZE/TOTAL_QUANTITY mode) priced at `rate`,
// plus the uploaded `saleAmount`. Plan amount is derived by figuresForMode(mode, plan, rate, nbv%).
interface SalesProduct { plan: number; rate: number; nbvPercent: number; saleAmount: number }
interface FakeOpts {
  assignedDealerIds: string[];
  dealers: { id: string; name: string }[];
  monthlyMode?: string; // "PACK_SIZE" (default, quantity) | "AMOUNT" | ...
  salesByDealer?: Record<string, Record<string, SalesProduct[]>>; // dealerId → monthName → product lines
  currentMonthName?: string; // e.g. "September"
  // Recovery: per-dealer monthRecoveryPlan/monthRunningRecovery/liveRecovery/srCr/due/overdue
  recoveryByDealer?: Record<string, { monthRecoveryPlan: number; monthRunningRecovery: number; liveRecovery: number; srCr: number; due: number; overdue: number }>;
  // Existing scheme-recovery scope: enrolled or Admin-verified plans, already filtered by the real query.
  recoverySchemes?: { dealerId: string; schemeId: string; schemeName: string }[];
  seed?: DW[];
}

function makeFake(opts: FakeOpts) {
  let store: DW[] = (opts.seed ?? []).map((r) => ({ ...r, batchId: r.batchId ?? `draft:${r.officerId}:${r.workDate}` }));
  const days = new Map<string, { currentBatchId: string; status: "OPEN" | "FINALIZED"; selfRating: number | null; finalizedAt: Date | null }>();
  for (const row of store) days.set(`${row.officerId}:${row.workDate}`, { currentBatchId: row.batchId!, status: "OPEN", selfRating: null, finalizedAt: null });
  const norm = (a: unknown, rest: unknown[]): Prisma.Sql => (Array.isArray(a) ? Prisma.sql(a as unknown as TemplateStringsArray, ...rest) : (a as Prisma.Sql));

  function runRaw(sql: Prisma.Sql): unknown {
    const text = sql.sql.replace(/\s+/g, " ").trim();
    const v = sql.values as unknown[];
    if (text.startsWith('SELECT e."dealerId", SUM(t."contribution")')) return [];
    if (text.startsWith('SELECT DISTINCT t."entryId"')) return [];
    if (text.startsWith('INSERT INTO "DailyWorkDay"')) {
      const officerId = v[1] as string, workDate = v[2] as string, currentBatchId = v[3] as string;
      if (!days.has(`${officerId}:${workDate}`)) days.set(`${officerId}:${workDate}`, { currentBatchId, status: "OPEN", selfRating: null, finalizedAt: null });
      return 1;
    }
    if (text.startsWith('SELECT "currentBatchId", "status", "selfRating", "finalizedAt"')) {
      const officerId = v[0] as string, workDate = v[1] as string;
      const day = days.get(`${officerId}:${workDate}`);
      return day ? [{ ...day }] : [];
    }
    // SELECT existing daily rows (now includes rowKey + new columns; Sales/Recovery only need these).
    if (text.startsWith('SELECT "id", "batchId", "dealerId", "rowKey"')) {
      const [officerId, section, workDate, currentBatchId] = v as string[];
      const report = text.includes("status\" IN ('PLAN_SUBMITTED'");
      return store.filter((r) => r.officerId === officerId && r.section === section && r.workDate === workDate
        && (report ? r.batchId !== currentBatchId && ["PLAN_SUBMITTED", "FINALIZED", "SUBMITTED"].includes(r.status) : r.batchId === currentBatchId && r.status === "DRAFT"))
        .map((r) => ({ id: r.id, batchId: r.batchId, dealerId: r.dealerId, rowKey: r.dealerId, typedDealerName: null, marketName: null, todaysPlan: r.todaysPlan, todaysActual: r.todaysActual, resultStatus: null, entryType: r.entryType, schemeId: r.schemeId, status: r.status }));
    }
    // DELETE replace-set: [officerId, section, workDate, ...keepRowKeys]  (rowKey == dealerId for Sales/Recovery)
    if (text.startsWith('DELETE FROM "DailyWorkEntry"')) {
      const officerId = v[0] as string, section = v[1] as string, workDate = v[2] as string, batchId = v[3] as string;
      const keep = v.slice(4) as string[];
      const before = store.length;
      store = store.filter((r) => !(r.officerId === officerId && r.section === section && r.workDate === workDate && r.batchId === batchId && !keep.includes(r.dealerId)));
      return before - store.length;
    }
    // INSERT ... ON CONFLICT DO UPDATE (upsert). Columns now: (id, officerId, dealerId, rowKey, workDate,
    // section, todaysPlan, entryType, schemeId, ...). `todaysPlan` is a bound `?` or the literal NULL.
    if (text.startsWith('INSERT INTO "DailyWorkEntry"')) {
      const planIsNull = /, NULL, \?, \?, 'DRAFT'/.test(text); // todaysPlan slot rendered as literal NULL
      const id = v[0] as string, officerId = v[1] as string, dealerId = v[2] as string /* rowKey = v[3] == dealerId */, workDate = v[4] as string, batchId = v[5] as string, section = v[6] as string;
      let i = 7;
      const todaysPlan = planIsNull ? null : String(v[i++] as number);
      const entryType = v[i++] as string;
      const schemeId = (v[i++] as string | null) ?? null;
      const existing = store.find((r) => r.officerId === officerId && r.workDate === workDate && r.batchId === batchId && r.section === section && r.dealerId === dealerId);
      if (existing) { existing.todaysPlan = todaysPlan; existing.entryType = entryType; existing.schemeId = schemeId; }
      else store.push({ id, officerId, dealerId, workDate, batchId, section, todaysPlan, todaysActual: null, entryType, schemeId, status: "DRAFT" });
      return 1;
    }
    // UPDATE ... SET status='SUBMITTED'
    if (text.includes("SET \"status\" = 'SUBMITTED'")) {
      const [officerId, section, workDate] = v as string[];
      let n = 0;
      for (const r of store) if (r.officerId === officerId && r.section === section && r.workDate === workDate && r.status === "DRAFT") { r.status = "SUBMITTED"; n++; }
      return n;
    }
    // UPDATE ... SET todaysActual = ? (post-submit)
    if (text.startsWith('UPDATE "DailyWorkEntry" SET "todaysActual"')) {
      const actual = v[0] as number, entryId = v[1] as string, officerId = v[2] as string, section = v[3] as string, workDate = v[4] as string, currentBatchId = v[5] as string;
      let n = 0;
      for (const r of store) if (r.id === entryId && r.officerId === officerId && r.section === section && r.workDate === workDate && r.batchId !== currentBatchId && r.status === "PLAN_SUBMITTED") { r.todaysActual = String(actual); n++; }
      return n;
    }
    throw new Error("Unhandled raw SQL: " + text);
  }

  const recMap = opts.recoveryByDealer ?? {};
  const monthName = opts.currentMonthName ?? "September";
  const hasSales = Object.keys(opts.salesByDealer ?? {}).length > 0;

  const prisma = {
    $queryRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    $executeRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    auditLog: { create: async () => ({}) },
    recoveryPlan: {
      findFirst: async () => (Object.keys(recMap).length ? {
        id: "rp1", seasonMonth: { name: monthName },
        dealers: Object.entries(recMap).map(([dealerId, f]) => ({ dealerId, ...f })),
      } : null),
    },
    dealerSchemePlan: {
      findMany: async () => (opts.recoverySchemes ?? []).map((r) => ({
        dealerId: r.dealerId, schemeId: r.schemeId, scheme: { schemeName: r.schemeName },
      })),
    },
    dealer: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => opts.dealers.filter((d) => where.id.in.includes(d.id)) },
  };

  // resolveAddableSeasonalPlanId mock — the app's canonical current-plan resolver (Daily Work reuses it).
  const resolveAddableSeasonalPlanId = async () => (hasSales ? "sp1" : null);

  // getMonthly mock — the AUTHORITATIVE Monthly Dealer Summary source. Model BOTH months so month-from-date
  // selection is exercised: the per-dealer `monthlyByDealer` maps each month name → product lines. A dealer
  // with data in September but none in October must return ₹0 for October (proves date-driven month).
  const months = [{ id: "m9", name: "September", order: 9, status: "OPEN" }, { id: "m10", name: "October", order: 10, status: "OPEN" }];
  const nameToId: Record<string, string> = { September: "m9", October: "m10" };
  const getMonthly = async () => ({
    planId: "sp1",
    monthlyMode: opts.monthlyMode ?? "PACK_SIZE",
    months,
    dealers: Object.entries(opts.salesByDealer ?? {}).map(([dealerId, byMonth]) => ({
      dealerId,
      // Build a product list whose `monthly` map carries a cell per month that has data for this dealer.
      products: buildProducts(byMonth, nameToId),
    })),
  });

  return {
    prisma, getMonthly, resolveAddableSeasonalPlanId,
    store: () => store.map((r) => ({ ...r })),
    freezeCurrent: (officerId: string, workDate: string) => {
      const day = days.get(`${officerId}:${workDate}`)!;
      for (const row of store) if (row.officerId === officerId && row.workDate === workDate && row.batchId === day.currentBatchId && row.status === "DRAFT") row.status = "PLAN_SUBMITTED";
      day.currentBatchId = `next:${officerId}:${workDate}`;
    },
  };
}

/** Turn a per-month product spec into getMonthly-shaped product lines (monthly map keyed by month id). */
function buildProducts(byMonth: Record<string, SalesProduct[]>, nameToId: Record<string, string>) {
  // Collect the union of product lines across months, aligning by index, so one product line carries a cell
  // for every month it appears in. Simplest faithful model: one product line per (month, entry).
  const products: { rate: number; nbvPercent: number; monthly: Record<string, { plan: number; sale: number; saleAmount: number }> }[] = [];
  for (const [mName, lines] of Object.entries(byMonth)) {
    const mId = nameToId[mName];
    for (const p of lines) products.push({ rate: p.rate, nbvPercent: p.nbvPercent, monthly: { [mId]: { plan: p.plan, sale: 0, saleAmount: p.saleAmount } } });
  }
  return products;
}

/* ------------------------------- Harness ------------------------------- */

const localRequire = createRequire(import.meta.url);
function loadService(fake: { prisma: object; getMonthly: () => Promise<unknown>; resolveAddableSeasonalPlanId: () => Promise<string | null> }, over: { assignedDealerIds: string[]; schemes?: { id: string; schemeName: string }[] }) {
  const filename = resolve("src/features/daily-work", "service.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    ...dailyWorkServiceInfrastructureMocks(fake.prisma as never),
    "server-only": {}, "@/lib/prisma": { prisma: fake.prisma },
    "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => 0 },
    "@/lib/http": { ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } } },
    "@/lib/scope": { getCurrentDealerIds: async () => over.assignedDealerIds },
    "@/lib/audit": { writeAudit: async () => ({}) },
    "@/features/labels/service.server": { getResolvedLabels: async () => localRequire(resolve("src/features/labels", "labels.ts")).DEFAULT_LABELS },
    "@/features/schemes/scheme-planning.server": { runningSchemes: async () => over.schemes ?? [] },
    "@/lib/scheme-financial-scope": { billFinancialScope: {} },
    // Reuse the REAL Monthly Dealer Summary source + calc engine + canonical plan resolver (the whole point).
    "@/features/planning/monthly.server": { getMonthly: fake.getMonthly },
    "@/features/planning/monthly-plan.server": { resolveAddableSeasonalPlanId: fake.resolveAddableSeasonalPlanId },
    "@/lib/calc": localRequire(resolve("src/lib", "calc.ts")),
    "@/lib/daily-work": localRequire(resolve("src/lib", "daily-work.ts")),
  };
  runInNewContext(code, { exports, Date, console, crypto, require: (id: string) => (id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id)) }, { filename });
  return exports as typeof import("./service.server");
}

const SO: AuthContext = { userId: "so1", role: Role.SALES_OFFICER, username: "so1", groupId: "g1" } as AuthContext;
const DATE = "2026-09-21";

async function expectStatus(fn: () => Promise<unknown>, status: number, label: string) {
  try { await fn(); assert.fail(`${label}: expected ${status} but succeeded`); }
  catch (e) { assert.equal((e as { status?: number }).status, status, `${label}: wrong status (${(e as Error).message})`); }
}

/* ------------------------------- Tests ------------------------------- */

async function main() {
  const dealers = [{ id: "d1", name: "Dealer A" }, { id: "d2", name: "Dealer B" }, { id: "dX", name: "Foreign" }];

  // 1) REGRESSION — the EXACT reproduction, 21 Sep 2026, quantity mode, month derived from the date.
  //    Reuses getMonthly (the Monthly Dealer Summary loader) with Aggregate="Selected Months" = September.
  //      DK trc Obedullaganj  → Plan ₹7,23,450 · Actual ₹3,86,508 · Pending ₹3,36,942
  //      Gothi Fertilizer     → Plan ₹3,74,949 · Actual ₹0         · Pending ₹3,74,949
  {
    const dd = [{ id: "dk", name: "DK trc Obedullaganj" }, { id: "gothi", name: "Gothi Fertilizer Itarsi" }];
    const f = makeFake({ assignedDealerIds: ["dk", "gothi"], dealers: dd, monthlyMode: "PACK_SIZE", salesByDealer: {
      // September only. Rates chosen so qty×rate lands on the exact rupee figures.
      dk: { September: [{ plan: 48230, rate: 15, nbvPercent: 0.2, saleAmount: 386508 }] },     // 48230×15 = 723450
      gothi: { September: [{ plan: 24996.6, rate: 15, nbvPercent: 0.2, saleAmount: 0 }] },      // 24996.6×15 = 374949
    } });
    const svc = loadService(f, { assignedDealerIds: ["dk", "gothi"] });
    await svc.saveDailyWork(SO, { section: "SALES", workDate: "2026-09-21", rows: [
      { dealerId: "dk", todaysPlan: 50000, entryType: "REGULAR" }, { dealerId: "gothi", todaysPlan: 40000, entryType: "REGULAR" },
    ] });
    const p = await svc.getDailyWork(SO, "SALES", "2026-09-21");
    assert.equal(p.monthName, "September", "month derived from the Daily Work date");
    const dk = p.dealers.find((d) => d.dealerId === "dk")!;
    assert.equal(dk.monthlyPlan, 723450, "DK Monthly Sales Plan = ₹7,23,450");
    assert.equal(dk.actual, 386508, "DK Actual Sales = ₹3,86,508");
    assert.equal(dk.pending, 336942, "DK Pending = ₹3,36,942");
    const gothi = p.dealers.find((d) => d.dealerId === "gothi")!;
    assert.equal(gothi.monthlyPlan, 374949, "Gothi Monthly Sales Plan = ₹3,74,949");
    assert.equal(gothi.actual, 0, "Gothi Actual Sales = ₹0");
    assert.equal(gothi.pending, 374949, "Gothi Pending = ₹3,74,949");
    // Combined (both dealers together): Plan 10,98,399 · Actual 3,86,508 · Pending 7,11,891.
    const combined = svc.combineDailyWork(p.dealers);
    assert.equal(combined.monthlyPlan, 1098399, "Combined Plan = ₹10,98,399");
    assert.equal(combined.actual, 386508, "Combined Actual = ₹3,86,508");
    assert.equal(combined.pending, 711891, "Combined Pending = ₹7,11,891");
  }

  // 1b) DYNAMIC MONTH — same dealer, a plan in September but NONE in October. On 15 Oct the September value
  //     must NOT leak; October (no data) → ₹0. Proves the month follows the Daily Work date, not the clock.
  {
    const dd = [{ id: "dk", name: "DK trc Obedullaganj" }];
    const f = makeFake({ assignedDealerIds: ["dk"], dealers: dd, monthlyMode: "PACK_SIZE", salesByDealer: {
      dk: { September: [{ plan: 48230, rate: 15, nbvPercent: 0.2, saleAmount: 386508 }] }, // no October entry
    } });
    const svcSep = loadService(f, { assignedDealerIds: ["dk"] });
    await svcSep.saveDailyWork(SO, { section: "SALES", workDate: "2026-09-21", rows: [{ dealerId: "dk", entryType: "REGULAR" }] });
    const sep = await svcSep.getDailyWork(SO, "SALES", "2026-09-21");
    assert.equal(sep.dealers.find((d) => d.dealerId === "dk")!.monthlyPlan, 723450, "September plan present");

    // October: a fresh section+date. Save then read for 15 Oct → month "October" has no data → ₹0.
    const svcOct = loadService(f, { assignedDealerIds: ["dk"] });
    await svcOct.saveDailyWork(SO, { section: "SALES", workDate: "2026-10-15", rows: [{ dealerId: "dk", entryType: "REGULAR" }] });
    const oct = await svcOct.getDailyWork(SO, "SALES", "2026-10-15");
    assert.equal(oct.monthName, "October", "month derived from 15 Oct");
    assert.equal(oct.dealers.find((d) => d.dealerId === "dk")!.monthlyPlan, 0, "October has no plan → ₹0 (no leak from September)");
  }

  // 1c) AMOUNT (value) mode still works: plan cell is a VALUE, amount = value directly.
  {
    const f = makeFake({ assignedDealerIds: ["d1"], dealers, monthlyMode: "AMOUNT", salesByDealer: {
      d1: { September: [{ plan: 500000, rate: 0, nbvPercent: 0.2, saleAmount: 300000 }] },
    } });
    const svc = loadService(f, { assignedDealerIds: ["d1"] });
    await svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "d1", entryType: "REGULAR" }] });
    const p = await svc.getDailyWork(SO, "SALES", DATE);
    const d1 = p.dealers.find((d) => d.dealerId === "d1")!;
    assert.equal(d1.monthlyPlan, 500000, "value-mode plan uses the entered amount");
    assert.equal(d1.pending, 200000);
  }

  // 2) RECOVERY read — Total Recovery Plan + Actual Total Recovery + pending.
  {
    const f = makeFake({ assignedDealerIds: ["d1"], dealers, recoveryByDealer: { d1: { monthRecoveryPlan: 150000, monthRunningRecovery: 50000, liveRecovery: 100000, srCr: 40000, due: 15000, overdue: 5000 } }, seed: [
      { id: "1", officerId: "so1", dealerId: "d1", workDate: DATE, section: "RECOVERY", todaysPlan: "30000", todaysActual: null, entryType: "REGULAR", schemeId: null, status: "DRAFT" },
    ] });
    const svc = loadService(f, { assignedDealerIds: ["d1"] });
    const p = await svc.getDailyWork(SO, "RECOVERY", DATE);
    const d1 = p.dealers.find((d) => d.dealerId === "d1")!;
    // Total Recovery Plan = 150000 + 50000 = 200000; Actual = 100000 + 40000 − (15000+5000) = 120000
    assert.equal(d1.monthlyPlan, 200000, "total recovery plan");
    assert.equal(d1.actual, 120000, "actual total recovery");
    assert.equal(d1.pending, 80000, "recovery pending = total plan − actual total");
  }

  // 2b) MULTIPLE dealers — combined summary sums current-month plan/actual, pending = plan − actual.
  {
    const dd = [{ id: "d1", name: "Dealer A" }, { id: "d2", name: "Dealer B" }];
    const f = makeFake({ assignedDealerIds: ["d1", "d2"], dealers: dd, monthlyMode: "PACK_SIZE", salesByDealer: {
      d1: { September: [{ plan: 30, rate: 10000, nbvPercent: 0.2, saleAmount: 220000 }] }, // ₹300000 plan
      d2: { September: [{ plan: 25, rate: 10000, nbvPercent: 0.2, saleAmount: 190000 }] }, // ₹250000 plan
    } });
    const svc = loadService(f, { assignedDealerIds: ["d1", "d2"] });
    await svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "d1", todaysPlan: 30000, entryType: "REGULAR" }, { dealerId: "d2", todaysPlan: 20000, entryType: "REGULAR" }] });
    const p = await svc.getDailyWork(SO, "SALES", DATE);
    const combined = svc.combineDailyWork(p.dealers);
    assert.equal(combined.dealerCount, 2);
    assert.equal(combined.monthlyPlan, 550000, "combined plan = 300000 + 250000");
    assert.equal(combined.pending, 140000, "combined pending = 80000 + 60000");
    assert.equal(combined.todaysPlan, 50000, "combined today's plan = 30000 + 20000");
  }

  // 2c) RECOVERY TYPE — Regular remains the default, while Scheme is dealer-specific and persists through
  //     draft, reload, submit and report reads. Switching back to Regular clears the scheme reference.
  {
    const f = makeFake({
      assignedDealerIds: ["d1", "d2"], dealers,
      recoveryByDealer: {
        d1: { monthRecoveryPlan: 150000, monthRunningRecovery: 0, liveRecovery: 25000, srCr: 0, due: 0, overdue: 0 },
        d2: { monthRecoveryPlan: 100000, monthRunningRecovery: 0, liveRecovery: 10000, srCr: 0, due: 0, overdue: 0 },
      },
      recoverySchemes: [{ dealerId: "d1", schemeId: "sc1", schemeName: "Scheme One" }],
    });
    const svc = loadService(f, { assignedDealerIds: ["d1", "d2"] });

    // Omitting entryType preserves the existing server default for a newly saved Recovery row.
    await svc.saveDailyWork(SO, { section: "RECOVERY", workDate: DATE, rows: [{ dealerId: "d1", todaysPlan: 30000 }] });
    assert.equal(f.store()[0].entryType, "REGULAR", "new Recovery rows default to Regular");

    // Regular → Scheme: only the dealer's existing scheme-recovery option is exposed and accepted.
    const beforeSave = await svc.getDailyWork(SO, "RECOVERY", DATE);
    assert.equal(JSON.stringify(beforeSave.applicableSchemesByDealer.d1), JSON.stringify([{ id: "sc1", name: "Scheme One" }]));
    assert.equal(beforeSave.applicableSchemesByDealer.d2, undefined, "dealer without scheme recovery has no Scheme option");
    await svc.saveDailyWork(SO, { section: "RECOVERY", workDate: DATE, rows: [{ dealerId: "d1", todaysPlan: 30000, entryType: "SCHEME", schemeId: "sc1" }] });
    assert.equal(f.store()[0].entryType, "SCHEME", "draft stores Scheme recovery type");
    assert.equal(f.store()[0].schemeId, "sc1", "draft stores the selected scheme");
    const draft = await svc.getDailyWork(SO, "RECOVERY", DATE);
    assert.equal(draft.dealers[0].entryType, "SCHEME", "draft reload preserves Scheme");
    assert.equal(draft.dealers[0].schemeId, "sc1", "draft reload preserves scheme reference");

    // A scheme from another/no eligible dealer is rejected by the same server-side applicability rule.
    await expectStatus(() => svc.saveDailyWork(SO, { section: "RECOVERY", workDate: DATE, rows: [{ dealerId: "d2", entryType: "SCHEME", schemeId: "sc1" }] }), 422, "scheme recovery requires an applicable dealer scheme");

    // Scheme → Regular keeps the row and clears the no-longer-applicable scheme reference.
    await svc.saveDailyWork(SO, { section: "RECOVERY", workDate: DATE, rows: [{ dealerId: "d1", todaysPlan: 30000, entryType: "REGULAR" }] });
    assert.equal(f.store()[0].entryType, "REGULAR", "Scheme can be changed back to Regular");
    assert.equal(f.store()[0].schemeId, null, "Regular recovery does not retain a stale scheme reference");

    // A frozen planning batch preserves the Scheme selection in Daily Report and never resets it.
    await svc.saveDailyWork(SO, { section: "RECOVERY", workDate: DATE, rows: [{ dealerId: "d1", todaysPlan: 30000, entryType: "SCHEME", schemeId: "sc1" }] });
    f.freezeCurrent("so1", DATE);
    const submitted = await svc.getDailyWork(SO, "RECOVERY", DATE, undefined, "REPORT");
    assert.equal(submitted.dealers[0].status, "PLAN_SUBMITTED");
    assert.equal(submitted.dealers[0].entryType, "SCHEME", "submitted/report Recovery type remains Scheme");
    assert.equal(submitted.dealers[0].schemeId, "sc1");

    // Type aggregation changes no rupee calculations: all Regular / all Scheme / mixed use the shared rule.
    const base = { monthlyPlan: 100, actual: 25, pending: 75, todaysPlan: 10, todaysActual: 5 };
    assert.equal(combineDailyWorkRows([{ ...base, type: "REGULAR" }, { ...base, type: "REGULAR" }]).type, "REGULAR");
    assert.equal(combineDailyWorkRows([{ ...base, type: "SCHEME" }, { ...base, type: "SCHEME" }]).type, "SCHEME");
    const mixed = combineDailyWorkRows([{ ...base, type: "REGULAR" }, { ...base, type: "SCHEME" }]);
    assert.equal(mixed.type, "MIXED");
    assert.equal(mixed.monthlyPlan, 200);
    assert.equal(mixed.pending, 150);
    assert.equal(mixed.todaysPlan, 20);
  }

  // 3) Save Draft persists rows; 4) unauthorized dealer rejected.
  {
    const f = makeFake({ assignedDealerIds: ["d1", "d2"], dealers });
    const svc = loadService(f, { assignedDealerIds: ["d1", "d2"] });
    const res = await svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "d1", todaysPlan: 30000, entryType: "REGULAR" }, { dealerId: "d2", todaysPlan: 20000, entryType: "REGULAR" }] });
    assert.equal(res.count, 2);
    assert.equal(f.store().filter((r) => r.status === "DRAFT").length, 2);
    await expectStatus(() => svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "dX", todaysPlan: 100, entryType: "REGULAR" }] }), 403, "unauthorized dealer");
  }

  // 5) Duplicate dealer rows rejected.
  {
    const f = makeFake({ assignedDealerIds: ["d1"], dealers });
    const svc = loadService(f, { assignedDealerIds: ["d1"] });
    await expectStatus(() => svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "d1", entryType: "REGULAR" }, { dealerId: "d1", entryType: "REGULAR" }] }), 422, "duplicate dealer");
  }

  // 6) Scheme validation: one applicable auto-ok; unknown scheme rejected; none rejected.
  {
    const schemes = [{ id: "sc1", schemeName: "Scheme One" }];
    const f = makeFake({ assignedDealerIds: ["d1"], dealers });
    const svc = loadService(f, { assignedDealerIds: ["d1"], schemes });
    // valid scheme id
    const ok = await svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "d1", entryType: "SCHEME", schemeId: "sc1" }] });
    assert.equal(ok.count, 1);
    assert.equal(f.store()[0].schemeId, "sc1");
    // unknown scheme id → 422
    await expectStatus(() => svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "d1", entryType: "SCHEME", schemeId: "nope" }] }), 422, "unknown scheme");
    // scheme type with no schemeId → 422
    await expectStatus(() => svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "d1", entryType: "SCHEME" }] }), 422, "missing scheme");
  }
  {
    // No applicable schemes at all → scheme row rejected.
    const f = makeFake({ assignedDealerIds: ["d1"], dealers });
    const svc = loadService(f, { assignedDealerIds: ["d1"], schemes: [] });
    await expectStatus(() => svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "d1", entryType: "SCHEME", schemeId: "x" }] }), 422, "no applicable schemes");
  }

  // 7) Submit flips DRAFT → SUBMITTED; 8) Today's Actual gating.
  {
    const f = makeFake({ assignedDealerIds: ["d1"], dealers });
    const svc = loadService(f, { assignedDealerIds: ["d1"] });
    // Actual BEFORE submit → 409 (nothing submitted).
    await svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "d1", todaysPlan: 30000, entryType: "REGULAR" }] });
    const entryId = f.store()[0].id;
    await expectStatus(() => svc.enterDailyActual(SO, { section: "SALES", workDate: DATE, entries: [{ entryId, todaysActual: 25000 }] }), 409, "actual before submit");
    // Freeze the planning batch; the exact entry then accepts its report actual.
    f.freezeCurrent("so1", DATE);
    assert.equal(f.store()[0].status, "PLAN_SUBMITTED");
    // Actual AFTER submit → persisted, distinct from Today's Plan.
    const r = await svc.enterDailyActual(SO, { section: "SALES", workDate: DATE, entries: [{ entryId, todaysActual: 25000 }] });
    assert.equal(r.count, 1);
    assert.equal(f.store()[0].todaysActual, "25000");
    assert.notEqual(f.store()[0].todaysActual, f.store()[0].todaysPlan, "today's sales ≠ today's plan");
  }

  // 9) Save Draft is a replace-set: removing a dealer from the payload deletes its row (recalc combined).
  {
    const f = makeFake({ assignedDealerIds: ["d1", "d2"], dealers, seed: [
      { id: "1", officerId: "so1", dealerId: "d1", workDate: DATE, section: "SALES", todaysPlan: "1", todaysActual: null, entryType: "REGULAR", schemeId: null, status: "DRAFT" },
      { id: "2", officerId: "so1", dealerId: "d2", workDate: DATE, section: "SALES", todaysPlan: "2", todaysActual: null, entryType: "REGULAR", schemeId: null, status: "DRAFT" },
    ] });
    const svc = loadService(f, { assignedDealerIds: ["d1", "d2"] });
    await svc.saveDailyWork(SO, { section: "SALES", workDate: DATE, rows: [{ dealerId: "d1", todaysPlan: 5, entryType: "REGULAR" }] });
    assert.deepEqual(f.store().map((r) => r.dealerId), ["d1"], "d2 removed on save");
    assert.equal(f.store()[0].todaysPlan, "5", "d1 updated in place (no duplicate)");
  }

  console.log("daily-work.test.ts (service) — all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
