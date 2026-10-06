/**
 * Service contracts for the additive DailyWorkDay + immutable planning-batch lifecycle.
 * The DB-free fake exercises the real service and proves repeatable Daily Plan submission, exact-entry
 * report actuals (including Visits), one final Self Rating, and the final day lock.
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

interface Entry {
  id: string; officerId: string; workDate: string; batchId: string; section: string; rowKey: string;
  dealerId: string | null; typedDealerName: string | null; todaysPlan: string | null; todaysActual: string | null;
  resultStatus: string | null; entryType: string; schemeId: string | null;
  dealerVisits: number | null; newPartyVisits: number | null;
  actualDealerVisits: number | null; actualNewPartyVisits: number | null;
  others: string | null; noPlanSections: string | null; status: string;
}
interface Day { currentBatchId: string; status: "OPEN" | "FINALIZED"; selfRating: number | null; finalizedAt: Date | null }

const DATE = "2026-09-21";
const OFFICER = "so1";
// Scheme Conversion is deliberately NOT in this set: it is temporarily disabled and must never block submit or the report.
const ALL_EXCEPT_SALES_AND_VISITS = "RECOVERY,APPOINTMENT,OTHERS";
const ALL_EXCEPT_SALES = `${ALL_EXCEPT_SALES_AND_VISITS},VISITS`;

function makeFake() {
  const entries: Entry[] = [];
  const days = new Map<string, Day>();
  let sequence = 0;
  const dayKey = (officerId: string, workDate: string) => `${officerId}:${workDate}`;
  const norm = (a: unknown, rest: unknown[]): Prisma.Sql => Array.isArray(a)
    ? Prisma.sql(a as unknown as TemplateStringsArray, ...rest)
    : a as Prisma.Sql;

  const currentDay = () => days.get(dayKey(OFFICER, DATE))!;
  const addPlan = (options: { salesPlan: number; dealerVisits?: number; newPartyVisits?: number }) => {
    const day = currentDay();
    const suffix = ++sequence;
    entries.push({
      id: `sales-${suffix}`, officerId: OFFICER, workDate: DATE, batchId: day.currentBatchId,
      section: "SALES", rowKey: "d1", dealerId: "d1", typedDealerName: null,
      todaysPlan: String(options.salesPlan), todaysActual: null, resultStatus: null, entryType: "REGULAR", schemeId: null,
      dealerVisits: null, newPartyVisits: null, actualDealerVisits: null, actualNewPartyVisits: null,
      others: null, noPlanSections: null, status: "DRAFT",
    });
    const hasVisits = options.dealerVisits != null || options.newPartyVisits != null;
    const summary: Entry = {
      id: `summary-${suffix}`, officerId: OFFICER, workDate: DATE, batchId: day.currentBatchId,
      section: "SUMMARY", rowKey: "SUMMARY", dealerId: null, typedDealerName: null,
      todaysPlan: null, todaysActual: null, resultStatus: null, entryType: "REGULAR", schemeId: null,
      dealerVisits: hasVisits ? (options.dealerVisits ?? 0) : null,
      newPartyVisits: hasVisits ? (options.newPartyVisits ?? 0) : null,
      actualDealerVisits: null, actualNewPartyVisits: null, others: null,
      noPlanSections: hasVisits ? ALL_EXCEPT_SALES_AND_VISITS : ALL_EXCEPT_SALES,
      status: "DRAFT",
    };
    const existingSummary = entries.find((row) => row.officerId === OFFICER && row.workDate === DATE && row.batchId === day.currentBatchId && row.section === "SUMMARY");
    if (existingSummary) Object.assign(existingSummary, summary, { id: existingSummary.id });
    else entries.push(summary);
  };

  function runRaw(sql: Prisma.Sql): unknown {
    const text = sql.sql.replace(/\s+/g, " ").trim();
    const v = sql.values as unknown[];
    if (text.startsWith('SELECT e."dealerId", SUM(t."contribution")')) return [];

    if (text.includes('"previousDayGate"')) {
      const officerId = v[0] as string, prev = v[1] as string;
      return [{
        planned: entries.some((row) => row.officerId === officerId && row.workDate === prev && ["PLAN_SUBMITTED", "FINALIZED"].includes(row.status)),
        // Honor the SQL: only a FINALIZED day counts when the query filters on it (a day row alone is not a submitted report).
        finalized: text.includes(`"status" = 'FINALIZED') AS "finalized"`) ? days.get(dayKey(officerId, prev))?.status === "FINALIZED" : days.has(dayKey(officerId, prev)),
      }];
    }
    if (text.startsWith('INSERT INTO "DailyWorkDay"')) {
      const officerId = v[1] as string, workDate = v[2] as string, currentBatchId = v[3] as string;
      if (!days.has(dayKey(officerId, workDate))) days.set(dayKey(officerId, workDate), { currentBatchId, status: "OPEN", selfRating: null, finalizedAt: null });
      return 1;
    }
    if (text.startsWith('SELECT "currentBatchId", "status", "selfRating", "finalizedAt"')) {
      const day = days.get(dayKey(v[0] as string, v[1] as string));
      return day ? [{ ...day }] : [];
    }
    if (text.includes('SELECT "section", COUNT(*)')) {
      const officerId = v[0] as string, workDate = v[1] as string, batchId = v[2] as string;
      const counts = new Map<string, bigint>();
      for (const row of entries.filter((entry) => entry.officerId === officerId && entry.workDate === workDate && entry.batchId === batchId && entry.status === "DRAFT")) {
        if (["SALES", "RECOVERY", "SCHEME_CONVERSION"].includes(row.section) || (row.section === "APPOINTMENT" && (row.typedDealerName ?? "").trim())) {
          counts.set(row.section, (counts.get(row.section) ?? 0n) + 1n);
        }
      }
      return [...counts].map(([section, n]) => ({ section, n }));
    }
    if (text.startsWith('SELECT ("dealerVisits" IS NOT NULL') && text.includes('"newPartyVisits" IS NOT NULL')) {
      const officerId = v[0] as string, workDate = v[1] as string, batchId = v[2] as string;
      const row = entries.find((e) => e.officerId === officerId && e.workDate === workDate && e.batchId === batchId && e.section === "SUMMARY" && e.status === "DRAFT");
      return [{ visits: row != null && (row.dealerVisits != null || row.newPartyVisits != null), others: (row?.others ?? "").trim() !== "" }];
    }
    if (text.startsWith('SELECT "noPlanSections"')) {
      const officerId = v[0] as string, workDate = v[1] as string, batchId = v[2] as string;
      const row = entries.find((entry) => entry.officerId === officerId && entry.workDate === workDate && entry.batchId === batchId && entry.section === "SUMMARY" && entry.status === "DRAFT");
      return row ? [{ noPlanSections: row.noPlanSections }] : [];
    }
    if (text.startsWith('SELECT "section", "batchId"')) {
      const officerId = v[0] as string, workDate = v[1] as string, currentBatchId = v[2] as string;
      return entries.filter((row) => row.officerId === officerId && row.workDate === workDate && row.batchId !== currentBatchId && ["PLAN_SUBMITTED", "FINALIZED", "SUBMITTED"].includes(row.status)).map((row) => ({ ...row }));
    }
    if (text.startsWith('SELECT "id", "batchId", "dealerId", "rowKey"')) {
      const officerId = v[0] as string, section = v[1] as string, workDate = v[2] as string, currentBatchId = v[3] as string;
      const report = text.includes("status\" IN ('PLAN_SUBMITTED'");
      return entries.filter((row) => row.officerId === officerId && row.section === section && row.workDate === workDate
        && (report ? row.batchId !== currentBatchId && ["PLAN_SUBMITTED", "FINALIZED", "SUBMITTED"].includes(row.status) : row.batchId === currentBatchId && row.status === "DRAFT"))
        .map((row) => ({ ...row }));
    }
    if (text.startsWith('SELECT "id", "batchId", "dealerVisits"')) {
      const officerId = v[0] as string, workDate = v[1] as string, currentBatchId = v[3] as string;
      const report = text.includes("status\" IN ('PLAN_SUBMITTED'");
      return entries.filter((row) => row.officerId === officerId && row.section === "SUMMARY" && row.workDate === workDate && row.rowKey === "SUMMARY"
        && (report ? row.batchId !== currentBatchId && ["PLAN_SUBMITTED", "FINALIZED", "SUBMITTED"].includes(row.status) : row.batchId === currentBatchId && row.status === "DRAFT"))
        .map((row) => ({ ...row }));
    }
    if (text.startsWith('INSERT INTO "DailyWorkEntry"') && text.includes('"noPlanSections"')) {
      const id = v[0] as string, officerId = v[1] as string, workDate = v[3] as string, batchId = v[4] as string, csv = (v[5] as string | null) ?? null;
      const existing = entries.find((row) => row.officerId === officerId && row.workDate === workDate && row.batchId === batchId && row.section === "SUMMARY");
      if (existing) existing.noPlanSections = csv;
      else entries.push({ id, officerId, workDate, batchId, section: "SUMMARY", rowKey: "SUMMARY", dealerId: null, typedDealerName: null, todaysPlan: null, todaysActual: null, resultStatus: null, entryType: "REGULAR", schemeId: null, dealerVisits: null, newPartyVisits: null, actualDealerVisits: null, actualNewPartyVisits: null, others: null, noPlanSections: csv, status: "DRAFT" });
      return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkEntry" SET "status" = \'PLAN_SUBMITTED\'')) {
      const officerId = v[0] as string, workDate = v[1] as string, batchId = v[2] as string;
      let count = 0;
      for (const row of entries) if (row.officerId === officerId && row.workDate === workDate && row.batchId === batchId && row.status === "DRAFT") { row.status = "PLAN_SUBMITTED"; count++; }
      return count;
    }
    if (text.startsWith('UPDATE "DailyWorkDay" SET "currentBatchId"')) {
      const day = days.get(dayKey(v[1] as string, v[2] as string))!;
      day.currentBatchId = v[0] as string;
      return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkEntry" SET "todaysActual"')) {
      const actual = v[0] as number, entryId = v[1] as string, officerId = v[2] as string, workDate = v[4] as string, currentBatchId = v[5] as string;
      const row = entries.find((entry) => entry.id === entryId && entry.officerId === officerId && entry.workDate === workDate && entry.batchId !== currentBatchId && entry.status === "PLAN_SUBMITTED");
      if (!row) return 0;
      row.todaysActual = String(actual);
      return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkEntry" SET "actualDealerVisits"')) {
      const entryId = v[2] as string, officerId = v[3] as string, workDate = v[4] as string, currentBatchId = v[5] as string;
      const row = entries.find((entry) => entry.id === entryId && entry.officerId === officerId && entry.workDate === workDate && entry.batchId !== currentBatchId && entry.status === "PLAN_SUBMITTED" && entry.section === "SUMMARY");
      if (!row) return 0;
      row.actualDealerVisits = v[0] as number;
      row.actualNewPartyVisits = v[1] as number;
      return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkDay" SET "status" = \'FINALIZED\'')) {
      const day = days.get(dayKey(v[1] as string, v[2] as string))!;
      if (day.status !== "OPEN") return 0;
      day.status = "FINALIZED";
      day.selfRating = v[0] as number;
      day.finalizedAt = new Date();
      return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkEntry" SET "status" = \'FINALIZED\'')) {
      const officerId = v[0] as string, workDate = v[1] as string;
      let count = 0;
      for (const row of entries) if (row.officerId === officerId && row.workDate === workDate && row.status === "PLAN_SUBMITTED") { row.status = "FINALIZED"; count++; }
      return count;
    }
    throw new Error(`Unhandled SQL: ${text}`);
  }

  const prisma = {
    $queryRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    $executeRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    auditLog: { create: async () => ({}) },
    dealer: { findMany: async () => [{ id: "d1", name: "Dealer One" }] },
    recoveryPlan: { findFirst: async () => null },
    dealerSchemePlan: { findMany: async () => [] },
  };
  return { prisma, entries, days, addPlan, currentDay };
}

// Mutable so a sub-test can simulate an unconfirmed materialized Auto Task blocking day submission.
let unconfirmedAutoTasks = 0;
const materializeCalls: string[] = []; // dates Auto Task materialization ran for during a submit
let unconfirmedChecks = 0; // how many times the submit gate looked for unconfirmed Auto Tasks
const localRequire = createRequire(import.meta.url);
function loadService(prisma: object) {
  const filename = resolve("src/features/daily-work", "service.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    ...dailyWorkServiceInfrastructureMocks(prisma as never),
    "./auto-task-materialization.server": {
      ...(dailyWorkServiceInfrastructureMocks(prisma as never)["./auto-task-materialization.server"] as object),
      materializeDueDailyWorkTasksInTransaction: async (_tx: unknown, _officer: string, workDate: string) => { materializeCalls.push(workDate); return { materializedTasks: 0, affectedDealers: 0, finalized: false }; },
    },
    "server-only": {}, "@/lib/prisma": { prisma },
    "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => { unconfirmedChecks++; return unconfirmedAutoTasks; } },
    "@/lib/http": { ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } } },
    "@/lib/scope": { getCurrentDealerIds: async () => ["d1"] },
    "@/lib/audit": { writeAudit: async () => ({}) },
    "@/features/labels/service.server": { getResolvedLabels: async () => localRequire(resolve("src/features/labels", "labels.ts")).DEFAULT_LABELS },
    "@/features/schemes/scheme-planning.server": { runningSchemes: async () => [] },
    "@/features/planning/monthly.server": { getMonthly: async () => ({ monthlyMode: "PACK_SIZE", months: [], dealers: [] }) },
    "@/features/planning/monthly-plan.server": { resolveAddableSeasonalPlanId: async () => null },
    "@/lib/scheme-plan-quantity": localRequire(resolve("src/lib", "scheme-plan-quantity.ts")),
    "@/lib/calc": localRequire(resolve("src/lib", "calc.ts")),
    "@/lib/daily-work": localRequire(resolve("src/lib", "daily-work.ts")),
  };
  runInNewContext(code, { exports, Date, console, crypto, require: (id: string) => id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id) }, { filename });
  return exports as typeof import("./service.server");
}

const dailyWorkLib = localRequire(resolve("src/lib", "daily-work.ts")) as typeof import("@/lib/daily-work");
/** Pin the business clock (the service reads `dailyWorkClock`). IST wall time → a fixed instant. */
const at = (isoWithOffset: string) => { dailyWorkLib.dailyWorkClock.now = () => new Date(isoWithOffset); };
const PREV = "2026-09-20"; // the calendar day before DATE
const SO: AuthContext = { userId: OFFICER, role: Role.SALES_OFFICER, username: OFFICER, groupId: "g1" } as AuthContext;
async function expectStatus(fn: () => Promise<unknown>, status: number, label: string) {
  try { await fn(); assert.fail(`${label}: expected ${status} but succeeded`); }
  catch (error) { assert.equal((error as { status?: number }).status, status, `${label}: ${(error as Error).message}`); }
}

/** A one-day scenario: Sales plan submitted + a submitted Recovery row with this ACTUAL amount / Payment Mode, then final submit. */
async function submitReportWithRecovery(actual: string, paymentMode: string | null) {
  const f = makeFake();
  const svc = loadService(f.prisma);
  await svc.setDailyNoPlan(SO, { workDate: DATE, section: "RECOVERY", noPlan: true });
  f.addPlan({ salesPlan: 100 });
  const batchId = f.currentDay().currentBatchId;
  await svc.submitDailyWorkDay(SO, { workDate: DATE });
  const sales = f.entries.find((row) => row.section === "SALES")!;
  f.entries.push({ ...sales, id: "rec-1", section: "RECOVERY", rowKey: "d1", todaysPlan: "5000", todaysActual: actual, paymentMode, batchId, status: "PLAN_SUBMITTED" } as typeof sales);
  await svc.enterDailyActual(SO, { section: "SALES", workDate: DATE, entries: [{ entryId: sales.id, todaysActual: 90 }] });
  return { f, run: () => svc.submitDailyReport(SO, { workDate: DATE, selfRating: 7 }) };
}

/** A previous-day state for `officer`: a submitted Sales plan with an actual, optionally with the Daily Report already finalized. */
function givePreviousDay(f: ReturnType<typeof makeFake>, officerId: string, opts: { finalized?: boolean } = {}) {
  f.days.set(`${officerId}:${PREV}`, { currentBatchId: `fresh-${officerId}`, status: opts.finalized ? "FINALIZED" : "OPEN", selfRating: opts.finalized ? 8 : null, finalizedAt: opts.finalized ? new Date() : null });
  f.entries.push({
    id: `prev-${officerId}`, officerId, workDate: PREV, batchId: `frozen-${officerId}`, section: "SALES", rowKey: "d1", dealerId: "d1", typedDealerName: null,
    todaysPlan: "100", todaysActual: "90", resultStatus: null, entryType: "REGULAR", schemeId: null, dealerVisits: null, newPartyVisits: null,
    actualDealerVisits: null, actualNewPartyVisits: null, others: null, noPlanSections: null, status: opts.finalized ? "FINALIZED" : "PLAN_SUBMITTED",
  });
}
/** Today's (DATE) plan ready to submit: Recovery marked No Plan + a Sales plan. */
async function readyToday(f: ReturnType<typeof makeFake>, ctx: AuthContext = SO) {
  const svc = loadService(f.prisma);
  await svc.setDailyNoPlan(ctx, { workDate: DATE, section: "RECOVERY", noPlan: true });
  f.addPlan({ salesPlan: 100 });
  return svc;
}
const planStatuses = (f: ReturnType<typeof makeFake>) => f.entries.filter((row) => row.workDate === DATE).map((row) => row.status);
const REQUIRED = "Submit the previous day's Daily Report before submitting today's Daily Plan.";
const TOO_LATE = "The Daily Report can only be submitted until 12:00 PM on the following day. This deadline has passed.";
async function expectMessage(fn: () => Promise<unknown>, status: number, message: string, label: string) {
  try { await fn(); assert.fail(`${label}: expected ${status} but succeeded`); }
  catch (error) { assert.equal((error as { status?: number }).status, status, `${label}: ${(error as Error).message}`); assert.equal((error as Error).message, message, label); }
}

async function previousDayRules() {
  // First applicable day: no plan was submitted yesterday → nothing outstanding → normal submission.
  { at("2026-09-21T10:00:00+05:30"); const f = makeFake(); const svc = await readyToday(f); assert.equal((await svc.submitDailyWorkDay(SO, { workDate: DATE })).ok, true, "first day submits"); }

  // Yesterday's plan was submitted but its report was not (before noon): today's plan is blocked, server-side, with nothing written.
  {
    at("2026-09-21T10:00:00+05:30");
    const f = makeFake(); givePreviousDay(f, OFFICER);
    const svc = await readyToday(f);
    const batchBefore = f.currentDay().currentBatchId;
    await expectMessage(() => svc.submitDailyWorkDay(SO, { workDate: DATE }), 422, REQUIRED, "blocked before noon");
    assert.deepEqual(planStatuses(f).every((status) => status === "DRAFT"), true, "a rejected submit freezes nothing");
    assert.equal(f.currentDay().currentBatchId, batchBefore, "and does not rotate the batch");
    const status = await svc.getDailyStatus(SO, DATE);
    assert.deepEqual([status.previousReport.state, status.previousReport.date, status.canSubmit], ["PENDING", PREV, false], "the status tells the page why");
    assert.equal(status.previousReport.deadline, "2026-09-21T06:30:00.000Z", "deadline = 12:00 IST on the following day");
    // Other actions stay available while blocked (No Plan toggle / reading status are unaffected).
    await svc.setDailyNoPlan(SO, { workDate: DATE, section: "RECOVERY", noPlan: false });
    // The report can still be submitted before noon, and that unblocks today's plan.
    await svc.setDailyNoPlan(SO, { workDate: DATE, section: "RECOVERY", noPlan: true });
    const prevReport = () => svc.submitDailyReport(SO, { workDate: PREV, selfRating: 7 });
    at("2026-09-21T11:59:59+05:30");
    assert.equal((await prevReport()).ok, true, "yesterday's report is accepted before the deadline");
    assert.equal((await svc.getDailyStatus(SO, DATE)).previousReport.state, "SUBMITTED");
    assert.equal((await svc.submitDailyWorkDay(SO, { workDate: DATE })).ok, true, "today's plan succeeds once yesterday's report is in");
  }

  // Submitting yesterday's still-open report never materializes Auto Tasks for that old day (they would be impossible to plan/finalize).
  {
    at("2026-09-21T09:00:00+05:30");
    const RM: AuthContext = { userId: OFFICER, role: Role.REGIONAL_MANAGER, username: OFFICER, groupId: "g1" } as AuthContext;
    const f = makeFake(); givePreviousDay(f, OFFICER); const svc = loadService(f.prisma);
    materializeCalls.length = 0;
    assert.equal((await svc.submitDailyReport(RM, { workDate: PREV, selfRating: 7 })).ok, true);
    assert.deepEqual(materializeCalls, [], "no Auto Task materialization for the previous day");
  }

  // The boundary: exactly 12:00:00.000 is still allowed; one millisecond later is rejected.
  {
    for (const [time, allowed] of [["2026-09-21T12:00:00.000+05:30", true], ["2026-09-21T12:00:00.001+05:30", false], ["2026-09-21T12:01:00+05:30", false]] as const) {
      at(time);
      const f = makeFake(); givePreviousDay(f, OFFICER);
      const svc = loadService(f.prisma);
      if (allowed) assert.equal((await svc.submitDailyReport(SO, { workDate: PREV, selfRating: 7 })).ok, true, `${time} accepted`);
      else await expectMessage(() => svc.submitDailyReport(SO, { workDate: PREV, selfRating: 7 }), 422, TOO_LATE, `${time} rejected`);
    }
    // 17: the deadline is business-timezone noon, not UTC noon and not the server's zone.
    at("2026-09-21T06:29:59Z"); { const f = makeFake(); givePreviousDay(f, OFFICER); assert.equal((await loadService(f.prisma).submitDailyReport(SO, { workDate: PREV, selfRating: 7 })).ok, true, "06:29:59Z = 11:59:59 IST"); }
    at("2026-09-21T06:30:01Z"); { const f = makeFake(); givePreviousDay(f, OFFICER); await expectMessage(() => loadService(f.prisma).submitDailyReport(SO, { workDate: PREV, selfRating: 7 }), 422, TOO_LATE, "06:30:01Z = 12:00:01 IST"); }
  }

  // After the deadline the missing report is MISSED (derived, nothing stored): it can no longer be submitted — and today's plan is ALLOWED.
  {
    at("2026-09-21T12:01:00+05:30");
    const f = makeFake(); givePreviousDay(f, OFFICER);
    // Actuals the user had entered but never submitted must stay exactly as they were.
    const snapshot = JSON.stringify(f.entries.filter((row) => row.workDate === PREV));
    const svc = await readyToday(f);
    const status = await svc.getDailyStatus(SO, DATE);
    assert.deepEqual([status.previousReport.state, status.canSubmit], ["MISSED", true], "missed previous report no longer blocks today's plan");
    await expectMessage(() => svc.submitDailyReport(SO, { workDate: PREV, selfRating: 7 }), 422, TOO_LATE, "the missed report cannot be submitted");
    const prevStatus = await svc.getDailyStatus(SO, PREV);
    assert.deepEqual([prevStatus.reportMissed, prevStatus.canSubmitReport, prevStatus.isFinalized], [true, false, false], "the old report is Missed, not actionable, not finalized");
    // Entering/changing the missed day's results is refused too (every report section), so it cannot be completed through the normal flow.
    const frozen = f.entries.find((row) => row.workDate === PREV)!;
    await expectMessage(() => svc.enterDailyActual(SO, { section: "SALES", workDate: PREV, entries: [{ entryId: frozen.id, todaysActual: 55 }] }), 422, TOO_LATE, "actuals refused after the deadline");
    await expectMessage(() => svc.enterVisitsActual(SO, { workDate: PREV, entries: [{ entryId: frozen.id, actualDealerVisits: 1, actualNewPartyVisits: 1 }] }), 422, TOO_LATE, "visits refused");
    await expectMessage(() => svc.enterAppointmentStatus(SO, { workDate: PREV, entries: [{ entryId: frozen.id, status: "APPOINTED" }] }), 422, TOO_LATE, "appointment refused");
    // …and the plan goes through normally.
    assert.equal((await svc.submitDailyWorkDay(SO, { workDate: DATE })).ok, true, "today's plan is allowed");
    // Missed is NOT a submission: no finalized day, no rating, no timestamp, no review record, data preserved untouched.
    const day = f.days.get(`${OFFICER}:${PREV}`)!;
    assert.deepEqual([day.status, day.selfRating, day.finalizedAt], ["OPEN", null, null], "nothing was finalized or rated for the missed day");
    assert.equal(JSON.stringify(f.entries.filter((row) => row.workDate === PREV)), snapshot, "the missed day's data is preserved as it was (never finalized, never zeroed)");
    // Still allowed later on; the deadline is about the previous report, not today's plan.
    at("2026-09-21T23:30:00+05:30");
    assert.equal((await svc.getDailyStatus(SO, DATE)).previousReport.state, "MISSED");
    // This day's own report window has not closed: its deadline is noon tomorrow.
    assert.equal((await svc.getDailyStatus(SO, DATE)).reportDeadlinePassed, false);
  }

  // No plan on the previous day → nothing to miss: NOT_APPLICABLE both before and after noon.
  for (const time of ["2026-09-21T10:00:00+05:30", "2026-09-21T15:00:00+05:30"]) {
    at(time);
    const f = makeFake(); const svc = await readyToday(f);
    const status = await svc.getDailyStatus(SO, DATE);
    assert.deepEqual([status.previousReport.state, status.canSubmit], ["NOT_APPLICABLE", true]);
    assert.equal((await svc.getDailyStatus(SO, PREV)).reportMissed, false, "a day without a plan is never Missed");
  }

  // The same Missed / pending behaviour for a Regional Manager and across users.
  {
    at("2026-09-21T13:00:00+05:30");
    const RM: AuthContext = { userId: OFFICER, role: Role.REGIONAL_MANAGER, username: OFFICER, groupId: "g1" } as AuthContext;
    const f = makeFake(); givePreviousDay(f, OFFICER); givePreviousDay(f, "so2", { finalized: true });
    const svc = await readyToday(f, RM);
    assert.equal((await svc.getDailyStatus(RM, DATE)).previousReport.state, "MISSED");
    assert.equal((await svc.submitDailyWorkDay(RM, { workDate: DATE })).ok, true, "an RM with a missed report can plan today");
    assert.equal((await svc.getDailyStatus({ ...SO, userId: "so2" } as AuthContext, PREV)).reportMissed, false, "another user's finalized report is never Missed");
  }

  // Today's plan is NOT subject to the noon cut-off: with yesterday's report in, it can be submitted in the evening.
  { at("2026-09-21T20:00:00+05:30"); const f = makeFake(); givePreviousDay(f, OFFICER, { finalized: true }); const svc = await readyToday(f); assert.equal((await svc.submitDailyWorkDay(SO, { workDate: DATE })).ok, true); }

  // Already finalized reports are untouched by the deadline (still 409 "submitted once", never rewritten), and never block a plan.
  {
    at("2026-09-25T09:00:00+05:30");
    const f = makeFake(); givePreviousDay(f, OFFICER, { finalized: true });
    const svc = await readyToday(f);
    const finalizedAt = f.days.get(`${OFFICER}:${PREV}`)!.finalizedAt;
    await expectStatus(() => svc.submitDailyReport(SO, { workDate: PREV, selfRating: 5 }), 409, "finalized report is not resubmitted (and not reported as late)");
    assert.equal(f.days.get(`${OFFICER}:${PREV}`)!.finalizedAt, finalizedAt, "timestamps untouched");
    assert.equal(f.days.get(`${OFFICER}:${PREV}`)!.selfRating, 8);
    assert.equal((await svc.submitDailyWorkDay(SO, { workDate: DATE })).ok, true, "a finalized previous report never blocks, however old");
  }

  // Report status after its own deadline: canSubmitReport is false and the page is told why.
  {
    const f = makeFake(); givePreviousDay(f, OFFICER); const svc = loadService(f.prisma);
    at("2026-09-21T11:00:00+05:30"); assert.equal((await svc.getDailyStatus(SO, PREV)).reportDeadlinePassed, false);
    at("2026-09-21T12:30:00+05:30"); const late = await svc.getDailyStatus(SO, PREV);
    assert.deepEqual([late.reportDeadlinePassed, late.canSubmitReport, late.reportDeadline], [true, false, "2026-09-21T06:30:00.000Z"]);
  }

  // Users never satisfy (or block) each other: another officer's finalized report does not unblock me, and mine does not unblock them.
  {
    at("2026-09-21T10:00:00+05:30");
    const f = makeFake(); givePreviousDay(f, OFFICER); givePreviousDay(f, "so2", { finalized: true });
    const svc = await readyToday(f);
    await expectMessage(() => svc.submitDailyWorkDay(SO, { workDate: DATE }), 422, REQUIRED, "another user's report does not count");
    const status = await svc.getDailyStatus(SO, DATE);
    assert.equal(status.previousReport.state, "PENDING");
  }

  // Regional Managers submit Daily Work too: the same rule applies (same service path, RM role).
  {
    at("2026-09-21T10:00:00+05:30");
    const RM: AuthContext = { userId: OFFICER, role: Role.REGIONAL_MANAGER, username: OFFICER, groupId: "g1" } as AuthContext;
    const f = makeFake(); givePreviousDay(f, OFFICER); const svc = await readyToday(f, RM);
    await expectMessage(() => svc.submitDailyWorkDay(RM, { workDate: DATE }), 422, REQUIRED, "RM blocked");
    at("2026-09-21T09:00:00+05:30");
    assert.equal((await svc.submitDailyReport(RM, { workDate: PREV, selfRating: 6 })).ok, true, "RM submits yesterday's report in time");
    assert.equal((await svc.submitDailyWorkDay(RM, { workDate: DATE })).ok, true, "RM plan then succeeds");
  }

  // Auto Task gate is unchanged: with yesterday's report in, an unconfirmed Auto Task still blocks, then confirming lets it through.
  {
    at("2026-09-21T10:00:00+05:30");
    const f = makeFake(); givePreviousDay(f, OFFICER, { finalized: true }); const svc = await readyToday(f);
    unconfirmedAutoTasks = 1;
    await expectStatus(() => svc.submitDailyWorkDay(SO, { workDate: DATE }), 422, "unconfirmed Auto Task still blocks");
    unconfirmedAutoTasks = 0;
    assert.equal((await svc.submitDailyWorkDay(SO, { workDate: DATE })).ok, true);
  }

  // Save Draft / No Plan paths do not consult the rule (only Submit does).
  const source = readFileSync("src/features/daily-work/service.server.ts", "utf8");
  const between = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  assert.ok(!between("export async function saveDailyWork(", "export async function submitDailyWork(").includes("previousReportGate"), "Save Draft is not gated");
  assert.ok(!between("export async function setDailyNoPlan(", "export async function submitDailyWorkDay(").includes("previousReportGate"), "No Plan is not gated");
}

async function main() {
  at("2026-09-22T09:00:00+05:30"); // the legacy scenarios below submit DATE's report the next morning, inside its window
  await previousDayRules();
  at("2026-09-22T09:00:00+05:30");
  // Payment Mode rule at final submission: a RECEIVED recovery (> 0) needs a mode; 0 / negative never does.
  {
    const blank = await submitReportWithRecovery("25000", null);
    await assert.rejects(blank.run, (error: Error & { status?: number }) => error.status === 422 && error.message === "Select Payment Mode for recovery amount.");
    assert.equal(blank.f.currentDay().status, "OPEN", "a positive recovery without Payment Mode is not finalized");
    for (const mode of ["CHEQUE", "UPI", "NEFT_RTGS", "CASH"]) assert.equal((await (await submitReportWithRecovery("25000", mode)).run()).ok, true, `positive recovery + ${mode} submits`);
    assert.equal((await (await submitReportWithRecovery("0", null)).run()).ok, true, "zero recovery submits without a Payment Mode");
    assert.equal((await (await submitReportWithRecovery("-5", null)).run()).ok, true, "a negative recovery never requires a Payment Mode");
  }
  const fake = makeFake();
  const svc = loadService(fake.prisma);

  const empty = await svc.getDailyStatus(SO, DATE);
  assert.deepEqual(empty.counts, { filled: 0, noPlan: 0, remaining: 5, total: 5 });
  assert.equal(empty.hasSubmittedWork, false);
  // The Auto Tasks block visibility flag defaults OFF and is surfaced for the UI only (stub returns false).
  assert.equal(empty.autoTasksEnabled, false);

  // First plan contains Sales plus a real Visits plan. Submit freezes it and rotates an empty editor.
  await svc.setDailyNoPlan(SO, { workDate: DATE, section: "RECOVERY", noPlan: true });
  fake.addPlan({ salesPlan: 100, dealerVisits: 5, newPartyVisits: 2 });
  const firstBatch = fake.currentDay().currentBatchId;
  // Submitting must NOT implicitly confirm Auto Tasks: while a materialized Auto Task is unconfirmed, day submit
  // is rejected. Once confirmed (count → 0) the normal submission lifecycle proceeds.
  unconfirmedAutoTasks = 1;
  await expectStatus(() => svc.submitDailyWorkDay(SO, { workDate: DATE }), 422, "unconfirmed Auto Task blocks submit");
  // An RM who OWNS a CN is its responsible officer: the same gate applies to them (their own unconfirmed Auto Task blocks
  // Submit Daily Work, a confirmed one — or none — lets it through). (Same officer id, RM role.)
  const RM_SAME: AuthContext = { userId: OFFICER, role: Role.REGIONAL_MANAGER, username: OFFICER, groupId: "g1" } as AuthContext;
  unconfirmedAutoTasks = 1; unconfirmedChecks = 0;
  await expectStatus(() => svc.submitDailyWorkDay(RM_SAME, { workDate: DATE }), 422, "RM's own unconfirmed Auto Task blocks submit");
  assert.ok(unconfirmedChecks > 0, "the gate consults the RM's own Auto Tasks");
  unconfirmedAutoTasks = 0;
  const first = await svc.submitDailyWorkDay(RM_SAME, { workDate: DATE });
  // A role that cannot own a CN is never gated by (or given) Auto Tasks.
  const ADMIN_CTX = { userId: OFFICER, role: Role.SUPER_ADMIN, username: "a", groupId: null } as AuthContext;
  await expectStatus(() => svc.submitDailyWorkDay(ADMIN_CTX, { workDate: DATE }), 403, "Admin is not a Daily Work owner");
  assert.equal(first.batchId, firstBatch);
  assert.notEqual(fake.currentDay().currentBatchId, firstBatch, "submission rotates a fresh batch");
  assert.equal((await svc.getDailyWork(SO, "SALES", DATE, undefined, "PLAN")).dealers.length, 0, "Daily Plan resets");

  // The same dealer may appear again in a second immutable batch on the same date.
  fake.addPlan({ salesPlan: 50 });
  const secondBatch = fake.currentDay().currentBatchId;
  const second = await svc.submitDailyWorkDay(SO, { workDate: DATE });
  assert.equal(second.batchId, secondBatch);
  assert.notEqual(secondBatch, firstBatch);
  const reportSales = await svc.getDailyWork(SO, "SALES", DATE, undefined, "REPORT");
  assert.equal(reportSales.dealers.length, 2);
  assert.equal(new Set(reportSales.dealers.map((row) => row.batchId)).size, 2);
  assert.equal(new Set(reportSales.dealers.map((row) => row.entryId)).size, 2);

  // Actuals update exact submitted entries, so duplicate dealer rows remain independent.
  const [salesOne, salesTwo] = reportSales.dealers;
  await svc.enterDailyActual(SO, { section: "SALES", workDate: DATE, entries: [{ entryId: salesOne.entryId, todaysActual: 90 }] });
  assert.equal(fake.entries.find((row) => row.id === salesOne.entryId)?.todaysActual, "90");
  assert.equal(fake.entries.find((row) => row.id === salesTwo.entryId)?.todaysActual, null);
  await svc.enterDailyActual(SO, { section: "SALES", workDate: DATE, entries: [{ entryId: salesTwo.entryId, todaysActual: 40 }] });

  // The Visits plan is incomplete until its two separate actual counts are entered.
  const beforeVisits = await svc.getDailyStatus(SO, DATE);
  assert.equal(beforeVisits.canSubmitReport, false);
  const visitsBatch = (await svc.getDailySummary(SO, DATE, undefined, "REPORT")).batches.find((row) => row.dealerVisits === 5)!;
  await assert.rejects(() => svc.enterVisitsActual(SO, { workDate: DATE, entries: [{ entryId: visitsBatch.entryId, actualDealerVisits: -1, actualNewPartyVisits: 1 }] }));
  await assert.rejects(() => svc.enterVisitsActual(SO, { workDate: DATE, entries: [{ entryId: visitsBatch.entryId, actualDealerVisits: 4.5, actualNewPartyVisits: 1 }] }));
  await svc.enterVisitsActual(SO, { workDate: DATE, entries: [{ entryId: visitsBatch.entryId, actualDealerVisits: 4, actualNewPartyVisits: 1 }] });
  const readyStatus = await svc.getDailyStatus(SO, DATE);
  assert.equal(readyStatus.canSubmitReport, true);

  // Saving Daily Report actuals (what Report autosave posts) never finalizes: the day is still OPEN, unrated and unlocked.
  assert.equal(fake.currentDay().status, "OPEN", "actuals saves leave the day OPEN");
  assert.equal(fake.currentDay().selfRating, null, "no self-rating is created by actuals saves");
  assert.equal(fake.currentDay().finalizedAt, null, "no finalization timestamp from actuals saves");
  assert.ok(fake.entries.filter((row) => row.workDate === DATE && row.status !== "DRAFT").every((row) => row.status === "PLAN_SUBMITTED"), "submitted rows are not FINALIZED by actuals saves");

  // Self Rating belongs only to final report submission. Finalization is once-only and locks every mutation.
  await expectStatus(() => svc.submitDailyReport(SO, { workDate: DATE }), 422, "final rating required");
  const finalized = await svc.submitDailyReport(SO, { workDate: DATE, selfRating: 8 });
  assert.equal(finalized.ok, true);
  assert.equal(fake.currentDay().status, "FINALIZED");
  assert.equal(fake.currentDay().selfRating, 8);
  assert.ok(fake.currentDay().finalizedAt);
  assert.ok(fake.entries.filter((row) => row.workDate === DATE).every((row) => row.status === "FINALIZED"));
  await expectStatus(() => svc.submitDailyReport(SO, { workDate: DATE, selfRating: 5 }), 409, "report finalizes once");
  await expectStatus(() => svc.setDailyNoPlan(SO, { workDate: DATE, section: "SALES", noPlan: true }), 409, "finalized day is locked");

  console.log("daily-work-completion.test.ts — all assertions passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
