/** One Daily Work row per distinct task: pure rules and wiring (the database behaviour is covered by task-rows.integration.ts). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { combineDailyWorkRows } from "@/lib/daily-work";
import { isTaskRowKey, taskRowKey } from "./task-rows.server";

// Row keys: a task's own identity, never the dealer; the dealer id stays the key of the ONE directly entered manual row.
assert.equal(taskRowKey("BE", "abc"), "t:BE:abc");
assert.equal(isTaskRowKey(taskRowKey("CAL", "x")), true);
assert.equal(isTaskRowKey("dealer-123"), false);
assert.notEqual(taskRowKey("CNP", "1"), taskRowKey("CNL", "1"), "different sources never collide");

// The example: one dealer, three tasks → 1 Dealer, 3 Tasks, Today's Plan ₹28,555; dealer-level figures are counted once.
const base = { dealerId: "d1", monthlyPlan: 100_000, actual: 40_000, pending: 60_000, todaysActual: 0, type: "REGULAR" as const };
const c = combineDailyWorkRows([{ ...base, todaysPlan: 12_444 }, { ...base, todaysPlan: 11_111 }, { ...base, todaysPlan: 5_000 }]);
assert.deepEqual([c.dealerCount, c.taskCount, c.dealerLabel, c.taskLabel, c.todaysPlan], [1, 3, "1 Dealer", "3 Tasks", 28_555]);
assert.deepEqual([c.monthlyPlan, c.actual, c.pending], [100_000, 40_000, 60_000], "monthly plan / actual / pending are dealer-level: not multiplied by the number of tasks");
const two = combineDailyWorkRows([{ ...base, todaysPlan: 1 }, { ...base, dealerId: "d2", monthlyPlan: 50_000, actual: 0, pending: 50_000, todaysPlan: 2 }, { ...base, todaysPlan: 3 }]);
assert.deepEqual([two.dealerCount, two.taskCount, two.monthlyPlan, two.pending, two.todaysPlan], [2, 3, 150_000, 110_000, 6]);
// Rows without a dealer id keep the old meaning (every row is its own dealer).
const legacy = combineDailyWorkRows([{ ...base, dealerId: undefined, todaysPlan: 1 }, { ...base, dealerId: undefined, todaysPlan: 2 }]);
assert.deepEqual([legacy.dealerCount, legacy.taskCount, legacy.monthlyPlan], [2, 2, 200_000]);
assert.equal(combineDailyWorkRows([]).taskLabel, "0 Tasks");

// Wiring.
const read = (p: string) => readFileSync(p, "utf8");
const service = read("src/features/daily-work/service.server.ts");
const save = service.slice(service.indexOf("export async function saveDailyWork("), service.indexOf("/* --------------------------------- Submit"));
assert.ok(save.includes(`"rowKey" NOT LIKE 't:%'`) && save.includes("submittedManualDealerIds(tx") && save.includes("manual_task_exists"), "save: only manual rows are replaced; the one-manual-task limit is checked on the server across batches");
assert.ok(save.indexOf("lockDailyWorkDay") < save.indexOf("submittedManualDealerIds(tx"), "…under the day lock, so concurrent requests serialize");
assert.ok(!save.includes("auto_task_amount") && !save.includes("auto_task_stale"), "scheduled tasks are no longer carried (or overwritten) by a save");
for (const f of ["billing-task.server.ts", "auto-task-materialization.server.ts", "calendar-task-materialization.server.ts"]) {
  const src = read(`src/features/daily-work/${f}`);
  assert.ok(src.includes("ensureTaskRow(") && src.includes("splitCombinedDraftRows("), `${f}: one row per task`);
  assert.ok(!/COALESCE\("todaysPlan", 0\) \+ \$\{/.test(src), `${f}: a task amount is never added into a shared row`);
}
const page = read("src/features/daily-work/daily-work-page.tsx");
assert.ok(page.includes('rows.filter((r) => r.rowKind === "MANUAL")') && page.includes("updateEntry(r.entryId"), "the editor sends only manual rows and binds edits to the entry id, not the position");
assert.ok(!/billingDealerIds|autoDealerIds|calendarDealerIds|autoTaskDealerId/.test(page), "task state is never keyed by dealer");
console.log("task-rows.test.ts — all assertions passed");
