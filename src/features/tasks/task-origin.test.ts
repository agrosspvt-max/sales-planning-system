import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

let originQueries = 0;
let lastSql: Prisma.Sql | undefined;
const createdAt = new Date("2026-10-18T04:30:00.000Z");
const { loadTaskOrigin } = testLoader({
  "@/lib/prisma": { prisma: { $queryRaw: async (sql: Prisma.Sql) => { originQueries++; lastSql = sql; return [{ createdAt, actorName: "Pankaj Verma" }]; } } },
})<typeof import("./task-origin.server")>("src/features/tasks/task-origin.server.ts");

async function main() {
  const start = await loadTaskOrigin("CALENDAR_ENTRY", "task:1");
  assert.equal(start?.createdAt, createdAt.toISOString());
  assert.equal(start?.actorName, "Pankaj Verma");
  const sql = lastSql!.strings.join("?");
  assert.ok(sql.includes('COALESCE(w."createdAt", c."createdAt")') && sql.includes('u."continuedAsId" = c."id"') && sql.includes('w."officerId" = c."ownerId"'), "manual continuation traces back to its own original Daily Work entry");
  assert.ok(sql.includes("'COMMITTED'") && sql.includes("'MANUAL_ROW'"), "draft or unrelated continuation records cannot become the origin");
  assert.ok(lastSql!.values.includes("task:1"), "identity is bound, not interpolated into SQL text");
  for (const type of ["BILLING_EXCEPTION", "CN_PAYMENT", "DAILY_WORK_ROW"]) assert.ok(await loadTaskOrigin(type, "one"));
  const before = originQueries;
  assert.equal(await loadTaskOrigin("CN_LEGACY", "one"), null, "request creation time is not invented as legacy task initiation");
  assert.equal(originQueries, before);

  // The history service must authorize the stable identity before fetching origin or events.
  let eventsRead = 0, allowed = true;
  const raw = { sourceType: "CALENDAR_ENTRY", taskId: "task1", ownerId: "so1", section: "RECOVERY", dealerId: null, taskType: "MANUAL", originalDate: "2026-10-19", originalVerified: true, currentDate: "2026-10-28", moves: 1, gap: false, completed: false, cancelled: false, abandoned: false, amount: "1000" };
  const { getTaskHistory } = testLoader({
    "@/lib/prisma": { prisma: {
      user: { findMany: async () => [] },
      $queryRaw: async (q: Prisma.Sql) => {
        const text = q.strings.join("?");
        if (text.startsWith('SELECT "sourceType","taskId"') && text.includes("SELECT 'CALENDAR_ENTRY'")) return [{ ...raw, ownerId: allowed ? "so1" : "someone-else" }];
        if (text.includes('SELECT e."id", e."previousDate"')) {
          eventsRead++;
          assert.ok(!text.includes("BETWEEN") && !text.includes('"workDate"'), "entire move history, no Performance date range");
          return [{ id: "m1", previousDate: "2026-10-19", newDate: "2026-10-28", actorName: "Pankaj Verma", actorRole: "SALES_OFFICER", reason: "Later visit", createdAt }];
        }
        return [];
      },
    } },
    "@/lib/http": { ApiError: TestApiError },
    "@/features/labels/service.server": { getResolvedLabels: async () => DEFAULT_LABELS },
    "./task-origin.server": { loadTaskOrigin },
  })<typeof import("./task-analysis.server")>("src/features/tasks/task-analysis.server.ts");
  const scope = { population: [{ id: "so1", name: "Pankaj Verma", role: "SALES_OFFICER", groupId: null, groupName: "CG" }], officers: [], states: [] };
  const history = await getTaskHistory(scope, "CALENDAR_ENTRY", "task1");
  assert.equal(history.events.length, 1);
  assert.equal(history.origin?.createdAt, createdAt.toISOString());
  const readBefore = { originQueries, eventsRead };
  allowed = false;
  await assert.rejects(() => getTaskHistory(scope, "CALENDAR_ENTRY", "task1"), (error: unknown) => (error as { status: number }).status === 404);
  assert.deepEqual({ originQueries, eventsRead }, readBefore, "out-of-scope task returns 404 before reading any history or origin");
  console.log("task-origin.test.ts — all assertions passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
