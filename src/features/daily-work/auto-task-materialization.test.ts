import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Prisma, Role } from "@prisma/client";

type Entry = { id: string; officerId: string; dealerId: string; rowKey?: string; workDate: string; batchId: string; section: string; todaysPlan: number; status: string };
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
    if (text.includes('"rowKey" NOT LIKE') && text.includes("EXISTS")) return []; // no historical combined draft rows in this fake (own real-database suite covers the split)
    if (text.startsWith('SELECT "id" FROM "DailyWorkEntry"')) {
      const [officerId, workDate, batchId, section, rowKey] = v as string[];
      return entries.filter((entry) => entry.officerId === officerId && entry.workDate === workDate && entry.batchId === batchId && entry.section === section && (entry.rowKey ?? entry.dealerId) === rowKey && entry.status === "DRAFT").map((entry) => ({ id: entry.id }));
    }
    if (text.startsWith('INSERT INTO "DailyWorkEntry"')) {
      const [id, officerId, dealerId, rowKey, workDate, batchId, section] = v as string[];
      if (!entries.some((entry) => entry.officerId === officerId && entry.workDate === workDate && entry.batchId === batchId && entry.section === section && (entry.rowKey ?? entry.dealerId) === rowKey)) {
        entries.push({ id, officerId, dealerId, rowKey, workDate, batchId, section, todaysPlan: 0, status: "DRAFT" });
      }
      return 1;
    }
    if (text.startsWith('DELETE FROM "DailyWorkEntry"')) {
      const [id] = v as string[];
      const at = entries.findIndex((entry) => entry.id === id && entry.status === "DRAFT" && (entry.rowKey ?? "").startsWith("t:") && entry.todaysPlan === 0 && !events.some((e) => e.dailyWorkEntryId === id) && !legacy.some((l) => l.dailyWorkEntryId === id));
      if (at >= 0) entries.splice(at, 1);
      return at >= 0 ? 1 : 0;
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
    "./billing-task.server": { materializeDueBillingTasksInTransaction: async () => ({ materialized: 0, affectedDealers: 0 }) }, // its own suite
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

  // Future tasks stay unconsumed; due and overdue tasks enter the current editable batch — EACH in its own row, with its own amount.
  {
    const f = makeDb({ events: [event("future", 9_000, "2026-09-30"), event("due", 10_000), event("overdue", 5_000, "2026-09-28")] });
    const result = await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.equal(result.materializedTasks, 2);
    assert.equal(result.affectedDealers, 1, "one dealer, two tasks");
    assert.deepEqual(f.entries.map((e) => [e.rowKey, e.todaysPlan]).sort(), [["t:CNP:due", 10_000], ["t:CNP:overdue", 5_000]], "two tasks of one dealer stay two rows with their original amounts");
    assert.ok(f.entries.every((e) => e.batchId === "batch-current"));
    assert.equal(f.events.find((x) => x.id === "future")?.dailyWorkEntryId, null);
    assert.equal(f.events.find((x) => x.id === "due")?.dailyWorkEntryId, f.entries.find((e) => e.rowKey === "t:CNP:due")?.id, "each task is linked to its OWN row");
    assert.equal(f.events.find((x) => x.id === "due")?.taskStatus, "SCHEDULED", "materialization never completes a payment task");
  }

  // The dealer's directly entered manual row is never touched or merged; repeated / concurrent reads create no duplicates; tasks reverse independently.
  {
    const manual: Entry = { id: "entry-1", officerId: "so-1", dealerId: "dealer-1", workDate: "2026-09-29", batchId: "batch-current", section: "RECOVERY", todaysPlan: 5_000, status: "DRAFT" };
    const f = makeDb({ entries: [manual], events: [event("a", 10_000), event("b", 15_000)] });
    await Promise.all([
      svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay),
      svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay),
    ]);
    const plans = () => Object.fromEntries(f.entries.map((e) => [e.rowKey ?? "manual", e.todaysPlan]));
    assert.deepEqual(plans(), { manual: 5_000, "t:CNP:a": 10_000, "t:CNP:b": 15_000 }, "manual 5,000 + two separate task rows");
    await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.equal(f.entries.length, 3, "refresh adds neither task twice");

    const rowA = f.entries.find((e) => e.rowKey === "t:CNP:a")!;
    await svc.reverseMaterializedDailyWorkContribution(f.db as never, { entryId: rowA.id, contribution: 10_000, officerId: "so-1", workDate: "2026-09-29", day: openDay });
    f.events[0]!.dailyWorkEntryId = null; f.events[0]!.dailyWorkContribution = null; f.events[0]!.taskDate = "2026-10-02";
    assert.deepEqual(plans(), { manual: 5_000, "t:CNP:a": 0, "t:CNP:b": 15_000 }, "only task A leaves; the manual row and task B are untouched");
    await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.equal(plans()["t:CNP:a"], 0, "a future reschedule is not rematerialized today");
    f.events[0]!.taskDate = "2026-09-29";
    await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.deepEqual(plans(), { manual: 5_000, "t:CNP:a": 10_000, "t:CNP:b": 15_000 }, "the same task identity returns to its own row when due again");
    assert.equal(f.entries.length, 3);

    const rowB = f.entries.find((e) => e.rowKey === "t:CNP:b")!;
    await svc.reverseMaterializedDailyWorkContribution(f.db as never, { entryId: rowB.id, contribution: 15_000, officerId: "so-1", workDate: "2026-09-29", day: openDay });
    assert.equal(plans()["t:CNP:b"], 0, "task contributions reverse independently");
    assert.equal(plans()["manual"], 5_000);
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
    assert.equal(f.entries.length, 1);
    assert.deepEqual([f.entries[0]?.rowKey, f.entries[0]?.todaysPlan], ["t:CNL:legacy-1", 7_500]);
    assert.equal(f.legacy[0]?.dailyWorkContribution, 7_500);
  }

  // ONE definition of "Auto Tasks apply": only Sales Officers (the only role shown, able to confirm or reschedule them).
  // The Recovery read path and both submit gates share it, so a gate can never fire for a task the user cannot see.
  {
    assert.equal(svc.autoTasksApplyToRole(Role.SALES_OFFICER), true);
    assert.equal(svc.autoTasksApplyToRole(Role.REGIONAL_MANAGER), true, "an RM owns CNs raised for themselves → gets their follow-up tasks");
    for (const role of [Role.SUPER_ADMIN, Role.CUSTOM_ADMIN]) assert.equal(svc.autoTasksApplyToRole(role), false, `${role}`);
    // Read path for roles that cannot own a CN: nothing is materialized and the database is never touched (prisma is an empty stub here).
    for (const role of [Role.SUPER_ADMIN, Role.CUSTOM_ADMIN]) {
      const r = await svc.materializeDueDailyWorkTasks({ userId: "rm-1", role, username: "rm", groupId: "g1" } as never);
      assert.equal(JSON.stringify(r), JSON.stringify({ materializedTasks: 0, affectedDealers: 0, finalized: false }), `${role}: no Auto Tasks created on read`);
    }
    const service = readFileSync("src/features/daily-work/service.server.ts", "utf8");
    assert.ok(service.includes("if (autoTasksApplyToRole(ctx.role)) {\n      await materializeDueDailyWorkTasksInTransaction"), "Submit Daily Work: materialize + unconfirmed check only where Auto Tasks apply");
    assert.ok(service.includes("autoTasksApplyToRole(ctx.role) && workDate === currentBusinessDate(dailyWorkClock.now())\n      ? await materializeDueDailyWorkTasksInTransaction"), "Submit Daily Report uses the same role rule (and only materializes for today's report)");
    assert.ok(/materializeDueDailyWorkTasks\(ctx\)/.test(service), "the Recovery read path still goes through the role-aware entry point");
  }

  // Applicability filters of the materializer itself: only the submitting officer's own, due, positive tasks; never another
  // officer's, never future ones, never zero-amount — so nothing stale/foreign/empty can produce an unconfirmed task.
  {
    const other = { ...event("other-officer", 4_000), officerId: "rm-9" };
    const zero = event("zero", 0);
    const f = makeDb({ events: [other, zero, event("future", 3_000, "2026-10-05"), event("mine", 6_000)] });
    const r = await svc.materializeDueDailyWorkTasksInTransaction(f.db as never, "so-1", "2026-09-29", openDay);
    assert.equal(r.materializedTasks, 1);
    assert.deepEqual(f.events.filter((e) => e.dailyWorkEntryId).map((e) => e.id), ["mine"], "only the officer's own due task is linked");
    assert.equal(f.entries.length, 1);
    // An RM-owned due task is materialized for the RM (same code path as an SO) and never for the SO — and vice versa.
    const g = makeDb({ events: [{ ...event("rm-task", 9_000), officerId: "rm-1" }, event("so-task", 2_000)] });
    assert.equal((await svc.materializeDueDailyWorkTasksInTransaction(g.db as never, "so-1", "2026-09-29", openDay)).materializedTasks, 1, "SO gets only the SO-owned task");
    assert.deepEqual(g.events.filter((e) => e.dailyWorkEntryId).map((e) => e.id), ["so-task"], "RM's task untouched by the SO's run");
    const rmRun = await svc.materializeDueDailyWorkTasksInTransaction(g.db as never, "rm-1", "2026-09-29", openDay);
    assert.equal(rmRun.materializedTasks, 1, "RM gets the RM-owned task");
    assert.deepEqual(g.events.filter((e) => e.dailyWorkEntryId).map((e) => e.id).sort(), ["rm-task", "so-task"]);
    assert.equal(g.entries.find((e) => e.officerId === "rm-1")?.todaysPlan, 9_000, "RM's Recovery row carries the RM task amount");
    assert.equal(g.entries.find((e) => e.officerId === "so-1")?.todaysPlan, 2_000, "SO's row is unaffected by the RM task");
  }

  console.log("auto-task-materialization.test.ts — all assertions passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
