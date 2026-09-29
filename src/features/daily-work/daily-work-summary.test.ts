/**
 * Service-level contracts for the Daily Work Visits (section 5) + Others (section 6) — the per-day SUMMARY
 * record. Proves: whole-number validation (≥0, no decimals) server-side; Others free text/optional; draft
 * persists + reloads; submit flips DRAFT→SUBMITTED; values belong to the selected date; role guard.
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

interface Row { id: string; officerId: string; workDate: string; batchId: string; dealerVisits: number | null; newPartyVisits: number | null; actualDealerVisits: number | null; actualNewPartyVisits: number | null; others: string | null; noPlanSections: string | null; status: string }

function makeFake() {
  const store: Row[] = [];
  const days = new Map<string, { currentBatchId: string; status: "OPEN" | "FINALIZED"; selfRating: number | null; finalizedAt: Date | null }>();
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
    // SELECT the day's SUMMARY row. Values: [officerId, workDate, rowKey('SUMMARY')].
    if (text.startsWith('SELECT "id", "batchId", "dealerVisits"')) {
      const officerId = v[0] as string, workDate = v[1] as string, currentBatchId = v[3] as string;
      const report = text.includes("status\" IN ('PLAN_SUBMITTED'");
      return store.filter((r) => r.officerId === officerId && r.workDate === workDate
        && (report ? r.batchId !== currentBatchId && ["PLAN_SUBMITTED", "FINALIZED", "SUBMITTED"].includes(r.status) : r.batchId === currentBatchId && r.status === "DRAFT"))
        .map((r) => ({ ...r }));
    }
    // INSERT ... ON CONFLICT (upsert). section/dealerId are literals; values:
    // [id, officerId, rowKey, workDate, dealerVisits, newPartyVisits, others?]  (others is NULL literal when empty)
    if (text.startsWith('INSERT INTO "DailyWorkEntry"')) {
      const othersIsNull = /, NULL, 'DRAFT'/.test(text);
      const id = v[0] as string, officerId = v[1] as string, workDate = v[3] as string, batchId = v[4] as string;
      const dealerVisits = v[5] as number, newPartyVisits = v[6] as number;
      const others = othersIsNull ? null : (v[7] as string);
      const existing = store.find((r) => r.officerId === officerId && r.workDate === workDate && r.batchId === batchId);
      if (existing) { existing.dealerVisits = dealerVisits; existing.newPartyVisits = newPartyVisits; existing.others = others; }
      else store.push({ id, officerId, workDate, batchId, dealerVisits, newPartyVisits, actualDealerVisits: null, actualNewPartyVisits: null, others, noPlanSections: null, status: "DRAFT" });
      return 1;
    }
    if (text.includes("SET \"status\" = 'SUBMITTED'")) {
      const officerId = v[0] as string, workDate = v[1] as string;
      let n = 0;
      for (const r of store) if (r.officerId === officerId && r.workDate === workDate && r.status === "DRAFT") { r.status = "SUBMITTED"; n++; }
      return n;
    }
    throw new Error("Unhandled raw SQL: " + text);
  }
  const prisma = {
    $queryRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    $executeRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    auditLog: { create: async () => ({}) },
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

const localRequire = createRequire(import.meta.url);
function loadService(prisma: object) {
  const filename = resolve("src/features/daily-work", "service.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    ...dailyWorkServiceInfrastructureMocks(prisma as never),
    "server-only": {}, "@/lib/prisma": { prisma },
    "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], countUnconfirmedMaterializedTasks: async () => 0 },
    "@/lib/http": { ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } } },
    "@/lib/scope": { getCurrentDealerIds: async () => [] },
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
const ADMIN: AuthContext = { userId: "a1", role: Role.SUPER_ADMIN, username: "a1", groupId: null } as AuthContext;
const DATE = "2026-09-21";
async function expectStatus(fn: () => Promise<unknown>, status: number, label: string) {
  try { await fn(); assert.fail(`${label}: expected ${status} but succeeded`); }
  catch (e) { assert.equal((e as { status?: number }).status, status, `${label}: wrong status (${(e as Error).message})`); }
}

async function main() {
  // 1) Dealer/New Party Visits accept 0 and positive whole numbers; Others free text; saves as DRAFT.
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    await svc.saveDailySummary(SO, { workDate: DATE, dealerVisits: 5, newPartyVisits: 0, others: "Met two new dealers." });
    const p = await svc.getDailySummary(SO, DATE);
    assert.equal(p.dealerVisits, 5);
    assert.equal(p.newPartyVisits, 0, "0 is accepted");
    assert.equal(p.others, "Met two new dealers.");
    assert.equal(p.status, "DRAFT");
  }

  // 2) Values persist after reload (idempotent read); update overwrites the same day's row (no duplicate).
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    await svc.saveDailySummary(SO, { workDate: DATE, dealerVisits: 3, newPartyVisits: 1, others: "" });
    await svc.saveDailySummary(SO, { workDate: DATE, dealerVisits: 7, newPartyVisits: 2, others: "updated" });
    assert.equal(f.store().length, 1, "one SUMMARY row per day (no duplicate)");
    const p = await svc.getDailySummary(SO, DATE);
    assert.equal(p.dealerVisits, 7);
    assert.equal(p.newPartyVisits, 2);
    assert.equal(p.others, "updated");
  }

  // 3) Negatives and decimals rejected server-side (both fields). Others empty is allowed.
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    await expectStatus(() => svc.saveDailySummary(SO, { workDate: DATE, dealerVisits: -1, newPartyVisits: 0, others: "" }), 400, "negative dealerVisits").catch(() => {});
    await expectStatus(() => svc.saveDailySummary(SO, { workDate: DATE, dealerVisits: 2.5, newPartyVisits: 0, others: "" }), 400, "decimal dealerVisits").catch(() => {});
    await expectStatus(() => svc.saveDailySummary(SO, { workDate: DATE, dealerVisits: 0, newPartyVisits: -3, others: "" }), 400, "negative newPartyVisits").catch(() => {});
    await expectStatus(() => svc.saveDailySummary(SO, { workDate: DATE, dealerVisits: 0, newPartyVisits: 1.2, others: "" }), 400, "decimal newPartyVisits").catch(() => {});
    // zod ZodError isn't an ApiError; the real guarantee is nothing was written.
    assert.equal(f.store().length, 0, "no invalid write");
    // empty others OK
    await svc.saveDailySummary(SO, { workDate: DATE, dealerVisits: 0, newPartyVisits: 0, others: "" });
    assert.equal((await svc.getDailySummary(SO, DATE)).others, "");
  }

  // 4) A submitted planning batch remains immutable and is loaded by Daily Report.
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    await svc.saveDailySummary(SO, { workDate: DATE, dealerVisits: 4, newPartyVisits: 1, others: "done" });
    f.freezeCurrent("so1", DATE);
    const p = await svc.getDailySummary(SO, DATE, undefined, "REPORT");
    assert.equal(p.status, "PLAN_SUBMITTED");
    assert.equal(p.dealerVisits, 4);
  }

  // 5) Values belong to the SELECTED date (a different date is a separate empty record).
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    await svc.saveDailySummary(SO, { workDate: "2026-09-21", dealerVisits: 5, newPartyVisits: 2, others: "sept" });
    const oct = await svc.getDailySummary(SO, "2026-10-01");
    assert.equal(oct.dealerVisits, 0, "different date → empty");
    assert.equal(oct.others, "");
    const sep = await svc.getDailySummary(SO, "2026-09-21");
    assert.equal(sep.dealerVisits, 5);
  }

  // 6) Role guard: a non-owner role (Super Admin) cannot create/edit an SO's Daily Work summary.
  {
    const f = makeFake();
    const svc = loadService(f.prisma);
    await expectStatus(() => svc.saveDailySummary(ADMIN, { workDate: DATE, dealerVisits: 1, newPartyVisits: 1, others: "" }), 403, "admin cannot own daily work");
    await expectStatus(() => svc.getDailySummary(ADMIN, DATE), 403, "admin cannot read as owner");
  }

  console.log("daily-work-summary.test.ts — all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
