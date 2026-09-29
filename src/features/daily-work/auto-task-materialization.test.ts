import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Prisma } from "@prisma/client";

type Entry = { id: string; officerId: string; dealerId: string; workDate: string; batchId: string; section: string; todaysPlan: number; status: string };
type Event = { id: string; officerId: string; dealerId: string; amount: number; taskDate: string; taskStatus: string; dailyWorkEntryId: string | null; dailyWorkContribution: number | null };
type Legacy = { id: string; officerId: string; dealerId: string; amount: number; taskDate: string; status: string; acceptanceReason: string; dailyWorkEntryId: string | null; dailyWorkContribution: number | null };

function makeDb(seed?: { entries?: Entry[]; events?: Event[]; legacy?: Legacy[] }) {
  const entries = structuredClone(seed?.entries ?? []);
  const events = structuredClone(seed?.events ?? []);
  const legacy = structuredClone(seed?.legacy ?? []);
  const norm = (query: unknown): Prisma.Sql => query as Prisma.Sql;
  const execute = async (query: unknown, read: boolean): Promise<unknown> => {
    const sql = norm(query);
    const text = sql.sql.replace(/\s+/g, " ").trim();
    const v = sql.values as unknown[];
    if (text.includes('FROM "CnPaymentEvent" e') && text.includes("FOR UPDATE OF e")) {
      const [officerId, workDate] = v as string[];
      return events.filter((event) => event.officerId === officerId && event.taskStatus === "SCHEDULED" && event.taskDate <= workDate && event.amount > 0 && !event.dailyWorkEntryId)
        .map((event) => ({ sourceId: event.id, dealerId: event.dealerId, amount: String(event.amount) }));
    }
    if (text.includes('FROM "CnRequest" c') && text.includes("FOR UPDATE OF c")) {
      const [officerId, workDate] = v as string[];
      return legacy.filter((task) => task.officerId === officerId && task.status === "ACCEPTED_NOT_POSTED" && task.acceptanceReason === "PAYMENT_PENDING" && task.taskDate <= workDate && task.amount > 0 && !task.dailyWorkEntryId)
        .map((task) => ({ sourceId: task.id, dealerId: task.dealerId, amount: String(task.amount) }));
    }
    if (text.startsWith('SELECT "id" FROM "DailyWorkEntry"')) {
      const [officerId, workDate, batchId, dealerId] = v as string[];
      return entries.filter((entry) => entry.officerId === officerId && entry.workDate === workDate && entry.batchId === batchId && entry.dealerId === dealerId && entry.section === "RECOVERY" && entry.status === "DRAFT").map(({ id }) => ({ id }));
    }
    if (text.startsWith('INSERT INTO "DailyWorkEntry"')) {
      const [id, officerId, dealerId, , workDate, batchId] = v as string[];
      if (!entries.some((entry) => entry.officerId === officerId && entry.workDate === workDate && entry.batchId === batchId && entry.section === "RECOVERY" && entry.dealerId === dealerId)) {
        entries.push({ id, officerId, dealerId, workDate, batchId, section: "RECOVERY", todaysPlan: 0, status: "DRAFT" });
      }
      return 1;
    }
    if (text.startsWith('UPDATE "CnPaymentEvent"') && text.includes('SET "dailyWorkEntryId"')) {
      const [entryId, contribution, id] = v as [string, number, string];
      const event = events.find((candidate) => candidate.id === id && !candidate.dailyWorkEntryId && candidate.taskStatus === "SCHEDULED");
      if (!event) return 0;
      event.dailyWorkEntryId = entryId; event.dailyWorkContribution = Number(contribution); return 1;
    }
    if (text.startsWith('UPDATE "CnRequest"') && text.includes('SET "legacyDailyWorkEntryId"')) {
      const [entryId, contribution, id] = v as [string, number, string];
      const task = legacy.find((candidate) => candidate.id === id && !candidate.dailyWorkEntryId && candidate.status === "ACCEPTED_NOT_POSTED");
      if (!task) return 0;
      task.dailyWorkEntryId = entryId; task.dailyWorkContribution = Number(contribution); return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkEntry"') && text.includes('COALESCE("todaysPlan"')) {
      const [amount, id, batchId] = v as [number, string, string];
      const entry = entries.find((candidate) => candidate.id === id && candidate.batchId === batchId && candidate.status === "DRAFT");
      if (!entry) return 0;
      entry.todaysPlan += Number(amount); return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkEntry"') && text.includes('array_remove')) return 1;
    if (text.startsWith('SELECT "id", "todaysPlan"::text')) {
      const [id, officerId, workDate, batchId] = v as string[];
      const entry = entries.find((candidate) => candidate.id === id && candidate.officerId === officerId && candidate.workDate === workDate && candidate.batchId === batchId && candidate.section === "RECOVERY" && candidate.status === "DRAFT");
      return entry ? [{ id: entry.id, todaysPlan: String(entry.todaysPlan) }] : [];
    }
    if (text.startsWith('UPDATE "DailyWorkEntry"') && text.includes('SET "todaysPlan" =')) {
      const [amount, id, batchId] = v as [number, string, string];
      const entry = entries.find((candidate) => candidate.id === id && candidate.batchId === batchId && candidate.status === "DRAFT");
      if (!entry) return 0;
      entry.todaysPlan = Number(amount); return 1;
    }
    throw new Error(`Unhandled ${read ? "query" : "execute"}: ${text}`);
  };
  const db = {
    $queryRaw: <T>(query: unknown) => execute(query, true) as Promise<T>,
    $executeRaw: (query: unknown) => execute(query, false),
  };
  return { db, entries, events, legacy };
}

function loadService() {
  const filename = resolve("src/features/daily-work/auto-task-materialization.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const localRequire = createRequire(import.meta.url);
  const mocks: Record<string, unknown> = {
    "server-only": {},
    "@/lib/prisma": { prisma: {} },
    "@/lib/http": { ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } },
    "@/lib/audit": { writeAudit: async () => undefined },
    "@/lib/daily-work": { currentBusinessDate: () => "2026-09-29" },
    "./day-lock.server": { lockDailyWorkDay: async () => ({ currentBatchId: "batch-current", status: "OPEN", selfRating: null, finalizedAt: null }) },
  };
  runInNewContext(code, { exports, console, Buffer, require: (id: string) => id in mocks ? mocks[id] : localRequire(id) }, { filename });
  return exports as typeof import("./auto-task-materialization.server");
}

const openDay = { currentBatchId: "batch-current", status: "OPEN" as const, selfRating: null, finalizedAt: null };
const finalizedDay = { ...openDay, status: "FINALIZED" as const };
const event = (id: string, amount: number, taskDate = "2026-09-29", dealerId = "dealer-1"): Event => ({
  id, officerId: "so-1", dealerId, amount, taskDate, taskStatus: "SCHEDULED", dailyWorkEntryId: null, dailyWorkContribution: null,
});

async function main() {
  const svc = loadService();

  // Future tasks stay unconsumed; due and overdue tasks enter the current editable batch.
  {
    const f = makeDb({ events: [event("future", 9_000, "2026-09-30"), event("due", 10_000), event("overdue", 5_000, "2026-09-28")] });
    const result = await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.equal(result.materializedTasks, 2);
    assert.equal(f.entries[0]?.todaysPlan, 15_000);
    assert.equal(f.entries[0]?.batchId, "batch-current");
    assert.equal(f.events.find((x) => x.id === "future")?.dailyWorkEntryId, null);
    assert.equal(f.events.find((x) => x.id === "due")?.taskStatus, "SCHEDULED", "materialization never completes a payment task");
  }

  // Existing manual row is reused; multiple tasks aggregate once and repeated/concurrent reads are idempotent.
  {
    const manual: Entry = { id: "entry-1", officerId: "so-1", dealerId: "dealer-1", workDate: "2026-09-29", batchId: "batch-current", section: "RECOVERY", todaysPlan: 5_000, status: "DRAFT" };
    const f = makeDb({ entries: [manual], events: [event("a", 10_000), event("b", 15_000)] });
    await Promise.all([
      svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay),
      svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay),
    ]);
    assert.equal(f.entries.length, 1);
    assert.equal(f.entries[0]?.todaysPlan, 30_000);
    await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.equal(f.entries[0]?.todaysPlan, 30_000, "refresh does not add either task twice");

    await svc.reverseMaterializedDailyWorkContribution(f.db as never, { entryId: "entry-1", contribution: 10_000, officerId: "so-1", workDate: "2026-09-29", day: openDay });
    f.events[0]!.dailyWorkEntryId = null; f.events[0]!.dailyWorkContribution = null; f.events[0]!.taskDate = "2026-10-02";
    assert.equal(f.entries[0]?.todaysPlan, 20_000, "only task A is removed; manual amount and task B remain");
    await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.equal(f.entries[0]?.todaysPlan, 20_000, "future reschedule is not rematerialized today");
    f.events[0]!.taskDate = "2026-09-29";
    await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.equal(f.entries[0]?.todaysPlan, 30_000, "the same task identity rematerializes when due again");
    assert.equal(f.events[0]?.id, "a");

    await svc.reverseMaterializedDailyWorkContribution(f.db as never, { entryId: "entry-1", contribution: 15_000, officerId: "so-1", workDate: "2026-09-29", day: openDay });
    assert.equal(f.entries[0]?.todaysPlan, 15_000, "task contributions reverse independently");
  }

  // A submitted batch is untouched; the current rotated batch receives the new row. Finalized days remain unchanged.
  {
    const submitted: Entry = { id: "old", officerId: "so-1", dealerId: "dealer-1", workDate: "2026-09-29", batchId: "batch-submitted", section: "RECOVERY", todaysPlan: 8_000, status: "PLAN_SUBMITTED" };
    const f = makeDb({ entries: [submitted], events: [event("new", 12_000)] });
    await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.equal(f.entries.find((x) => x.id === "old")?.todaysPlan, 8_000);
    assert.equal(f.entries.find((x) => x.batchId === "batch-current")?.todaysPlan, 12_000);
    const entryCount = f.entries.length;
    const finalized = await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", finalizedDay);
    assert.equal(finalized.finalized, true);
    assert.equal(f.entries.length, entryCount);
  }

  // Historical taskDate-on-CnRequest rows use the same durable, idempotent link.
  {
    const f = makeDb({ legacy: [{ id: "legacy-1", officerId: "so-1", dealerId: "dealer-2", amount: 7_500, taskDate: "2026-09-29", status: "ACCEPTED_NOT_POSTED", acceptanceReason: "PAYMENT_PENDING", dailyWorkEntryId: null, dailyWorkContribution: null }] });
    await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.equal(f.entries[0]?.todaysPlan, 7_500);
    assert.equal(f.legacy[0]?.dailyWorkContribution, 7_500);
  }

  console.log("auto-task-materialization.test.ts — all assertions passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
