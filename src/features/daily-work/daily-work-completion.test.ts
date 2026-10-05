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
const localRequire = createRequire(import.meta.url);
function loadService(prisma: object) {
  const filename = resolve("src/features/daily-work", "service.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    ...dailyWorkServiceInfrastructureMocks(prisma as never),
    "server-only": {}, "@/lib/prisma": { prisma },
    "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => unconfirmedAutoTasks },
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

const SO: AuthContext = { userId: OFFICER, role: Role.SALES_OFFICER, username: OFFICER, groupId: "g1" } as AuthContext;
async function expectStatus(fn: () => Promise<unknown>, status: number, label: string) {
  try { await fn(); assert.fail(`${label}: expected ${status} but succeeded`); }
  catch (error) { assert.equal((error as { status?: number }).status, status, `${label}: ${(error as Error).message}`); }
}

async function main() {
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
  unconfirmedAutoTasks = 0;
  const first = await svc.submitDailyWorkDay(SO, { workDate: DATE });
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
