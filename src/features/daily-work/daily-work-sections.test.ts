/**
 * Service-level contracts for the Daily Work Dealer Appointment (section 3) + Scheme Conversion (section 4)
 * flows, loading the real `service.server.ts` with a DB-free fake. Proves:
 *   Appointment — typed dealer/market persist; plan/pending are placeholders (null); status is post-submit;
 *                 only APPOINTED/NOT_APPOINTED; unique client rows.
 *   Conversion  — planned schemes come from APPROVED DealerSchemePlan (units = Σ numberOfSchemes; converted =
 *                 Σ where schemeStatus=CONVERTED; pending = planned − converted); one vs many planned schemes;
 *                 no-planned-scheme rejected; today ≤ pending (incl. pending 0 → no positive plan); duplicate
 *                 (dealer,scheme) rejected; Yes/No achievability post-submit only; unauthorized dealer blocked.
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

/* ------------------------------- In-memory DailyWorkEntry store + fake ------------------------------- */

interface DW {
  id: string; officerId: string; dealerId: string | null; rowKey: string; workDate: string; batchId?: string; section: string;
  typedDealerName: string | null; marketName: string | null; todaysPlan: string | null; todaysActual: string | null;
  resultStatus: string | null; entryType: string; schemeId: string | null; status: string;
}
interface PlanRow { dealerId: string; schemeId: string; numberOfSchemes: number; schemeStatus: string; schemeName: string }

function makeFake(opts: { assignedDealerIds: string[]; dealers: { id: string; name: string }[]; plans?: PlanRow[]; seed?: DW[] }) {
  let store: DW[] = (opts.seed ?? []).map((r) => ({ ...r, batchId: r.batchId ?? `draft:${r.officerId}:${r.workDate}` }));
  const days = new Map<string, { currentBatchId: string; status: "OPEN" | "FINALIZED"; selfRating: number | null; finalizedAt: Date | null }>();
  for (const row of store) days.set(`${row.officerId}:${row.workDate}`, { currentBatchId: row.batchId!, status: "OPEN", selfRating: null, finalizedAt: null });
  const norm = (a: unknown, rest: unknown[]): Prisma.Sql => (Array.isArray(a) ? Prisma.sql(a as unknown as TemplateStringsArray, ...rest) : (a as Prisma.Sql));

  function runRaw(sql: Prisma.Sql): unknown {
    const text = sql.sql.replace(/\s+/g, " ").trim();
    const v = sql.values as unknown[];
    if (text.startsWith('SELECT e."dealerId", SUM(t."contribution")')) return [];

    if (text.startsWith('INSERT INTO "DailyWorkDay"')) {
      const officerId = v[1] as string, workDate = v[2] as string, currentBatchId = v[3] as string;
      if (!days.has(`${officerId}:${workDate}`)) days.set(`${officerId}:${workDate}`, { currentBatchId, status: "OPEN", selfRating: null, finalizedAt: null });
      return 1;
    }
    if (text.startsWith('SELECT "currentBatchId", "status", "selfRating", "finalizedAt"')) {
      const day = days.get(`${v[0] as string}:${v[1] as string}`);
      return day ? [{ ...day }] : [];
    }

    // section is a bound ${} for SALES/RECOVERY reads, but a literal for the new sections. Detect the literal.
    const literalSection = text.includes("'APPOINTMENT'") ? "APPOINTMENT" : text.includes("'SCHEME_CONVERSION'") ? "SCHEME_CONVERSION" : null;

    if (text.startsWith('SELECT "id", "batchId", "dealerId", "rowKey"')) {
      // bound values: [officerId, section?, workDate] — section present only when NOT a literal.
      const officerId = v[0] as string;
      const section = literalSection ?? (v[1] as string);
      const workDate = (literalSection ? v[1] : v[2]) as string;
      const currentBatchId = (literalSection ? v[2] : v[3]) as string;
      const report = text.includes("status\" IN ('PLAN_SUBMITTED'");
      return store.filter((r) => r.officerId === officerId && r.section === section && r.workDate === workDate
        && (report ? r.batchId !== currentBatchId && ["PLAN_SUBMITTED", "FINALIZED", "SUBMITTED"].includes(r.status) : r.batchId === currentBatchId && r.status === "DRAFT"))
        .map((r) => ({ ...r }));
    }
    if (text.startsWith('DELETE FROM "DailyWorkEntry"')) {
      const officerId = v[0] as string;
      const section = literalSection ?? (v[1] as string);
      const workDate = (literalSection ? v[1] : v[2]) as string;
      const batchId = (literalSection ? v[2] : v[3]) as string;
      const keep = v.slice(literalSection ? 3 : 4) as string[];
      const before = store.length;
      store = store.filter((r) => !(r.officerId === officerId && r.section === section && r.workDate === workDate && r.batchId === batchId && !keep.includes(r.rowKey)));
      return before - store.length;
    }
    // Appointment INSERT — section is the literal 'APPOINTMENT'; dealerId is literal NULL. Bound values are
    // [id, officerId, rowKey, workDate, typedDealerName, marketName?] (marketName is literal NULL when empty).
    if (text.startsWith('INSERT INTO "DailyWorkEntry"') && text.includes("'APPOINTMENT'")) {
      const marketIsNull = /, NULL, 'DRAFT'/.test(text); // "…, <market NULL>, 'DRAFT', …"
      const id = v[0] as string, officerId = v[1] as string, rowKey = v[2] as string, workDate = v[3] as string, batchId = v[4] as string;
      const typedDealerName = v[5] as string;
      const marketName = marketIsNull ? null : (v[6] as string);
      const existing = store.find((r) => r.officerId === officerId && r.workDate === workDate && r.batchId === batchId && r.section === "APPOINTMENT" && r.rowKey === rowKey);
      if (existing) { existing.typedDealerName = typedDealerName; existing.marketName = marketName; }
      else store.push({ id, officerId, dealerId: null, rowKey, workDate, batchId, section: "APPOINTMENT", typedDealerName, marketName, todaysPlan: null, todaysActual: null, resultStatus: null, entryType: "REGULAR", schemeId: null, status: "DRAFT" });
      return 1;
    }
    // Scheme Conversion INSERT — section is the literal 'SCHEME_CONVERSION'. Bound values are
    // [id, officerId, dealerId, rowKey, workDate, schemeId, todaysPlan].
    if (text.startsWith('INSERT INTO "DailyWorkEntry"') && text.includes("'SCHEME_CONVERSION'")) {
      const id = v[0] as string, officerId = v[1] as string, dealerId = v[2] as string, rowKey = v[3] as string, workDate = v[4] as string, batchId = v[5] as string;
      const schemeId = v[6] as string, todaysPlan = String(v[7] as number);
      const existing = store.find((r) => r.officerId === officerId && r.workDate === workDate && r.batchId === batchId && r.section === "SCHEME_CONVERSION" && r.rowKey === rowKey);
      if (existing) { existing.todaysPlan = todaysPlan; }
      else store.push({ id, officerId, dealerId, rowKey, workDate, batchId, section: "SCHEME_CONVERSION", typedDealerName: null, marketName: null, todaysPlan, todaysActual: null, resultStatus: null, entryType: "REGULAR", schemeId, status: "DRAFT" });
      return 1;
    }
    if (text.includes("SET \"status\" = 'SUBMITTED'")) {
      const officerId = v[0] as string;
      const section = literalSection ?? (v[1] as string);
      const workDate = (literalSection ? v[1] : v[2]) as string;
      let n = 0;
      for (const r of store) if (r.officerId === officerId && r.section === section && r.workDate === workDate && r.status === "DRAFT") { r.status = "SUBMITTED"; n++; }
      return n;
    }
    // resultStatus UPDATE (appointment status / conversion achievability). section is a literal in the SQL,
    // so bound values are [resultStatus, officerId, workDate, rowKey]; the section is read from the text.
    if (text.startsWith('UPDATE "DailyWorkEntry" SET "resultStatus"')) {
      const section = text.includes("'APPOINTMENT'") ? "APPOINTMENT" : "SCHEME_CONVERSION";
      const result = v[0] as string, entryId = v[1] as string, officerId = v[2] as string, workDate = v[3] as string, currentBatchId = v[4] as string;
      let n = 0;
      for (const r of store) if (r.id === entryId && r.officerId === officerId && r.section === section && r.workDate === workDate && r.batchId !== currentBatchId && r.status === "PLAN_SUBMITTED") { r.resultStatus = result; n++; }
      return n;
    }
    throw new Error("Unhandled raw SQL: " + text);
  }

  const prisma = {
    $queryRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    $executeRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    auditLog: { create: async () => ({}) },
    dealer: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => opts.dealers.filter((d) => where.id.in.includes(d.id)) },
    dealerSchemePlan: {
      findMany: async () => (opts.plans ?? []).map((p) => ({ dealerId: p.dealerId, schemeId: p.schemeId, numberOfSchemes: p.numberOfSchemes, schemeStatus: p.schemeStatus, scheme: { schemeName: p.schemeName } })),
    },
  };
  return {
    prisma,
    store: () => store.map((r) => ({ ...r })),
    freezeCurrent: (officerId: string, workDate: string) => {
      const day = days.get(`${officerId}:${workDate}`)!;
      for (const row of store) if (row.officerId === officerId && row.workDate === workDate && row.batchId === day.currentBatchId && row.status === "DRAFT") row.status = "PLAN_SUBMITTED";
      day.currentBatchId = `next:${officerId}:${workDate}`;
    },
  };
}

/* ------------------------------- Harness ------------------------------- */

const localRequire = createRequire(import.meta.url);
function loadService(prisma: object, assignedDealerIds: string[]) {
  const filename = resolve("src/features/daily-work", "service.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    ...dailyWorkServiceInfrastructureMocks(prisma as never),
    "server-only": {}, "@/lib/prisma": { prisma },
    "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => 0 },
    "@/lib/http": { ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } } },
    "@/lib/scope": { getCurrentDealerIds: async () => assignedDealerIds },
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

const SO: AuthContext = { userId: "so1", role: Role.SALES_OFFICER, username: "so1", groupId: "g1" } as AuthContext;
const DATE = "2026-09-21";
async function expectStatus(fn: () => Promise<unknown>, status: number, label: string) {
  try { await fn(); assert.fail(`${label}: expected ${status} but succeeded`); }
  catch (e) { assert.equal((e as { status?: number }).status, status, `${label}: wrong status (${(e as Error).message})`); }
}

/* ------------------------------- Tests ------------------------------- */

async function main() {
  /* ============ DEALER APPOINTMENT ============ */
  // 1) Typed dealer + market persist; plan/pending are placeholders (null); status not available before submit.
  {
    const f = makeFake({ assignedDealerIds: [], dealers: [] });
    const svc = loadService(f.prisma, []);
    await svc.saveDailyAppointment(SO, { workDate: DATE, rows: [
      { rowId: "r1", dealerName: "Dealer A", marketName: "Bhopal" },
      { rowId: "r2", dealerName: "Dealer B", marketName: "Sehore" },
    ] });
    const p = await svc.getDailyAppointment(SO, DATE);
    assert.equal(p.rows.length, 2);
    const a = p.rows.find((r) => r.dealerName === "Dealer A")!;
    assert.equal(a.marketName, "Bhopal");
    assert.equal(a.monthlyPlan, null, "Monthly Dealer Plan is a placeholder");
    assert.equal(a.pending, null, "Pending is a placeholder");
    assert.equal(a.status, null, "no status before submit");
    assert.equal(p.canEnterStatus, false);
  }

  // 2) Status only after submit; only APPOINTED / NOT_APPOINTED; before submit → 409.
  {
    const f = makeFake({ assignedDealerIds: [], dealers: [] });
    const svc = loadService(f.prisma, []);
    await svc.saveDailyAppointment(SO, { workDate: DATE, rows: [{ rowId: "r1", dealerName: "Dealer A", marketName: "Bhopal" }] });
    const entryId = f.store()[0].id;
    await expectStatus(() => svc.enterAppointmentStatus(SO, { workDate: DATE, entries: [{ entryId, status: "APPOINTED" }] }), 409, "status before submit");
    f.freezeCurrent("so1", DATE);
    const r = await svc.enterAppointmentStatus(SO, { workDate: DATE, entries: [{ entryId, status: "NOT_APPOINTED" }] });
    assert.equal(r.count, 1);
    const p = await svc.getDailyAppointment(SO, DATE, undefined, "REPORT");
    assert.equal(p.canEnterStatus, true);
    assert.equal(p.rows[0].status, "NOT_APPOINTED");
  }

  // 3) Duplicate client row id rejected.
  {
    const f = makeFake({ assignedDealerIds: [], dealers: [] });
    const svc = loadService(f.prisma, []);
    await expectStatus(() => svc.saveDailyAppointment(SO, { workDate: DATE, rows: [{ rowId: "r1", dealerName: "A", marketName: "" }, { rowId: "r1", dealerName: "B", marketName: "" }] }), 422, "duplicate appointment row");
  }

  /* ============ SCHEME CONVERSION ============ */
  const dealers = [{ id: "dk", name: "DK trc Obedullaganj" }, { id: "d2", name: "Dealer Two" }, { id: "dX", name: "Foreign" }];

  // 4) Planned units + converted + pending; one planned scheme auto-usable.
  {
    // DK has scheme A across two segments: 4 + 2 = 6 planned; one segment (2) CONVERTED → converted 2, pending 4.
    const plans = [
      { dealerId: "dk", schemeId: "A", numberOfSchemes: 4, schemeStatus: "PENDING", schemeName: "Scheme A" },
      { dealerId: "dk", schemeId: "A", numberOfSchemes: 2, schemeStatus: "CONVERTED", schemeName: "Scheme A" },
    ];
    const f = makeFake({ assignedDealerIds: ["dk"], dealers, plans });
    const svc = loadService(f.prisma, ["dk"]);
    const p = await svc.getDailyConversion(SO, DATE);
    const dk = p.availableDealers.find((d) => d.dealerId === "dk")!;
    assert.equal(dk.schemes.length, 1, "DK has exactly one planned scheme");
    assert.equal(dk.schemes[0].plannedUnits, 6, "planned = 4 + 2");
    assert.equal(dk.schemes[0].convertedUnits, 2, "converted = CONVERTED segment");
    assert.equal(dk.schemes[0].pending, 4, "pending = 6 − 2");
  }

  // 5) Multiple planned schemes for a dealer are all listed.
  {
    const plans = [
      { dealerId: "dk", schemeId: "A", numberOfSchemes: 6, schemeStatus: "PENDING", schemeName: "Scheme A" },
      { dealerId: "dk", schemeId: "B", numberOfSchemes: 8, schemeStatus: "PENDING", schemeName: "Scheme B" },
    ];
    const f = makeFake({ assignedDealerIds: ["dk"], dealers, plans });
    const svc = loadService(f.prisma, ["dk"]);
    const p = await svc.getDailyConversion(SO, DATE);
    const dk = p.availableDealers.find((d) => d.dealerId === "dk")!;
    const names = dk.schemes.map((s) => s.schemeName).sort();
    assert.equal(names.length, 2, `expected 2 planned schemes, got ${JSON.stringify(names)}`);
    assert.equal(names[0], "Scheme A");
    assert.equal(names[1], "Scheme B");
  }

  // 6) Save with a valid planned scheme; today ≤ pending enforced; pending 0 blocks positive; unknown scheme blocked.
  {
    const plans = [{ dealerId: "dk", schemeId: "A", numberOfSchemes: 6, schemeStatus: "PENDING", schemeName: "Scheme A" }]; // planned 6, pending 6
    const f = makeFake({ assignedDealerIds: ["dk"], dealers, plans });
    const svc = loadService(f.prisma, ["dk"]);
    // valid
    const ok = await svc.saveDailyConversion(SO, { workDate: DATE, rows: [{ dealerId: "dk", schemeId: "A", todaysPlan: 4 }] });
    assert.equal(ok.count, 1);
    // today > pending → 422
    await expectStatus(() => svc.saveDailyConversion(SO, { workDate: DATE, rows: [{ dealerId: "dk", schemeId: "A", todaysPlan: 7 }] }), 422, "today > pending (max is 6/pending)").catch(() => {});
    // scheme not planned for dealer → 422
    await expectStatus(() => svc.saveDailyConversion(SO, { workDate: DATE, rows: [{ dealerId: "dk", schemeId: "ZZZ", todaysPlan: 1 }] }), 422, "unknown scheme");
    // unauthorized dealer → 403
    await expectStatus(() => svc.saveDailyConversion(SO, { workDate: DATE, rows: [{ dealerId: "dX", schemeId: "A", todaysPlan: 1 }] }), 403, "unauthorized dealer");
  }

  // 6b) Pending 0 prevents a positive Today's Plan.
  {
    const plans = [{ dealerId: "dk", schemeId: "A", numberOfSchemes: 3, schemeStatus: "CONVERTED", schemeName: "Scheme A" }]; // planned 3, converted 3, pending 0
    const f = makeFake({ assignedDealerIds: ["dk"], dealers, plans });
    const svc = loadService(f.prisma, ["dk"]);
    await expectStatus(() => svc.saveDailyConversion(SO, { workDate: DATE, rows: [{ dealerId: "dk", schemeId: "A", todaysPlan: 1 }] }), 422, "pending 0 blocks positive plan");
    // todaysPlan 0 is allowed even at pending 0
    const ok = await svc.saveDailyConversion(SO, { workDate: DATE, rows: [{ dealerId: "dk", schemeId: "A", todaysPlan: 0 }] });
    assert.equal(ok.count, 1);
  }

  // 7) Duplicate (dealer, scheme) rejected.
  {
    const plans = [{ dealerId: "dk", schemeId: "A", numberOfSchemes: 6, schemeStatus: "PENDING", schemeName: "Scheme A" }];
    const f = makeFake({ assignedDealerIds: ["dk"], dealers, plans });
    const svc = loadService(f.prisma, ["dk"]);
    await expectStatus(() => svc.saveDailyConversion(SO, { workDate: DATE, rows: [{ dealerId: "dk", schemeId: "A", todaysPlan: 1 }, { dealerId: "dk", schemeId: "A", todaysPlan: 2 }] }), 422, "duplicate dealer+scheme");
  }

  // 8) Achievability Yes/No only AFTER submit; separate from Today's Plan; not auto-derived.
  {
    const plans = [{ dealerId: "dk", schemeId: "A", numberOfSchemes: 6, schemeStatus: "PENDING", schemeName: "Scheme A" }];
    const f = makeFake({ assignedDealerIds: ["dk"], dealers, plans });
    const svc = loadService(f.prisma, ["dk"]);
    await svc.saveDailyConversion(SO, { workDate: DATE, rows: [{ dealerId: "dk", schemeId: "A", todaysPlan: 2 }] });
    const entryId = f.store()[0].id;
    await expectStatus(() => svc.enterConversionAchievability(SO, { workDate: DATE, entries: [{ entryId, achievability: "YES" }] }), 409, "achievability before submit");
    f.freezeCurrent("so1", DATE);
    const r = await svc.enterConversionAchievability(SO, { workDate: DATE, entries: [{ entryId, achievability: "NO" }] });
    assert.equal(r.count, 1);
    const p = await svc.getDailyConversion(SO, DATE, undefined, "REPORT");
    const row = p.rows.find((x) => x.dealerId === "dk" && x.schemeId === "A")!;
    assert.equal(row.achievability, "NO");
    assert.equal(row.todaysPlan, 2, "Today's Plan unchanged by achievability (separate fields)");
  }

  // 9) A dealer with NO planned scheme is not offered, and a conversion row for it is rejected.
  {
    const f = makeFake({ assignedDealerIds: ["d2"], dealers, plans: [] }); // d2 assigned but no plans
    const svc = loadService(f.prisma, ["d2"]);
    const p = await svc.getDailyConversion(SO, DATE);
    assert.equal(p.availableDealers.length, 0, "no dealers with planned schemes → none offered");
    await expectStatus(() => svc.saveDailyConversion(SO, { workDate: DATE, rows: [{ dealerId: "d2", schemeId: "A", todaysPlan: 1 }] }), 422, "no planned scheme");
  }

  // Scheme Conversion is TEMPORARILY disabled in Daily Work: the write guard used by the routes rejects it (409) and
  // allows every other section; the conversion service functions above are intact (history/re-enable).
  {
    const f = makeFake({ assignedDealerIds: [], dealers: [] });
    const svc = loadService(f.prisma, []);
    await expectStatus(async () => svc.assertDailyWorkSectionWritable("SCHEME_CONVERSION"), 409, "disabled section is not writable");
    for (const section of ["SALES", "RECOVERY", "APPOINTMENT", "VISITS", "OTHERS", "SUMMARY", undefined]) assert.doesNotThrow(() => svc.assertDailyWorkSectionWritable(section), String(section));
  }

  console.log("daily-work-sections.test.ts — all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
