/** Performance → Tasks pure rules. DB-free.   npx tsx src/lib/task-analysis.test.ts */
import assert from "node:assert/strict";
import {
  dateTrail, daysMoved, defaultTaskFilters, deriveHistoryState, deriveTaskStatus, distinctTrailDates, intensityLevel, monthBounds, previewHistory,
  rescheduleCalendarCounts, shiftMonth, summarizeTasks, taskQueryString, type SummaryTask,
} from "./task-analysis";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };
const ev = (previousDate: string, newDate: string, n = 0) => ({ previousDate, newDate, createdAt: `2026-08-0${1 + n}T10:00:00Z` });

test("status: completed / cancelled only from source evidence; otherwise Overdue once the CURRENT date has passed, else Pending (today is not yet passed)", () => {
  const t = { today: "2026-10-15", cancelled: false };
  assert.equal(deriveTaskStatus({ ...t, completed: true, currentDate: "2026-01-01" }), "COMPLETED", "completion beats a past date");
  assert.equal(deriveTaskStatus({ ...t, completed: false, currentDate: "2026-10-14" }), "OVERDUE");
  assert.equal(deriveTaskStatus({ ...t, completed: false, currentDate: "2026-10-15" }), "PENDING", "due today is pending");
  assert.equal(deriveTaskStatus({ ...t, completed: false, currentDate: "2026-10-20" }), "PENDING");
  assert.equal(deriveTaskStatus({ today: "2026-10-15", completed: false, cancelled: true, currentDate: "2026-10-01" }), "CANCELLED", "cancelled is its own state, not Overdue");
  assert.equal(deriveTaskStatus({ today: "2026-10-15", completed: true, cancelled: true, currentDate: "2026-10-01" }), "CANCELLED");
});

test("history state: a gap with nothing recorded is UNAVAILABLE (unknown, never a verified zero); a gap with later moves is PARTIAL; no gap is COMPLETE even at zero moves", () => {
  assert.equal(deriveHistoryState({ gap: false, moves: 0 }), "COMPLETE");
  assert.equal(deriveHistoryState({ gap: false, moves: 4 }), "COMPLETE");
  assert.equal(deriveHistoryState({ gap: true, moves: 0 }), "UNAVAILABLE");
  assert.equal(deriveHistoryState({ gap: true, moves: 2 }), "PARTIAL");
});

test("days moved: signed days from the ORIGINAL to the current date; unknown (null) when the original is not verified", () => {
  assert.equal(daysMoved("2026-10-14", "2026-10-20", true), 6);
  assert.equal(daysMoved("2026-10-20", "2026-10-14", true), -6);
  assert.equal(daysMoved("2026-10-14", "2026-10-14", true), 0);
  assert.equal(daysMoved("2026-10-14", "2026-10-20", false), null);
  assert.equal(daysMoved("2026-02-27", "2026-03-02", true), 3, "across a month end");
});

test("date trail: original, then every date it was moved to — a revisit stays in the trail, distinct dates count once", () => {
  const moves = [ev("2026-08-10", "2026-08-13", 0), ev("2026-08-13", "2026-08-15", 1)];
  assert.deepEqual(dateTrail(moves), { trail: ["2026-08-10", "2026-08-13", "2026-08-15"], chainOk: true });
  const back = [ev("2026-10-14", "2026-10-16", 0), ev("2026-10-16", "2026-10-18", 1), ev("2026-10-18", "2026-10-16", 2)];
  const { trail } = dateTrail(back);
  assert.deepEqual(trail, ["2026-10-14", "2026-10-16", "2026-10-18", "2026-10-16"]);
  assert.deepEqual(distinctTrailDates(trail), ["2026-10-14", "2026-10-16", "2026-10-18"]);
  assert.deepEqual(dateTrail([]), { trail: [], chainOk: true });
  assert.equal(dateTrail([ev("2026-10-14", "2026-10-16", 0), ev("2026-10-17", "2026-10-18", 1)]).chainOk, false, "a broken chain is reported, not hidden");
  assert.deepEqual(dateTrail([ev("2026-09-28", "2026-10-03", 0)]).trail, ["2026-09-28", "2026-10-03"], "moves across months");
});

test("reschedule calendar: one task moved 10/08 → 13/08 → 15/08 is ONE task on three dates (and two reschedules elsewhere); a revisit counts once; tasks add up per date", () => {
  const a = { key: "A", dates: distinctTrailDates(dateTrail([ev("2026-08-10", "2026-08-13", 0), ev("2026-08-13", "2026-08-15", 1)]).trail) };
  const counts = rescheduleCalendarCounts([a]);
  assert.deepEqual([...counts].sort(), [["2026-08-10", 1], ["2026-08-13", 1], ["2026-08-15", 1]]);
  const b = { key: "B", dates: dateTrail([ev("2026-08-10", "2026-08-12", 0), ev("2026-08-12", "2026-08-10", 1), ev("2026-08-10", "2026-08-13", 2)]).trail }; // leaves and RETURNS to 10/08
  const both = rescheduleCalendarCounts([a, b]);
  assert.equal(both.get("2026-08-10"), 2, "two distinct tasks; B's revisit of the 10th does not make it 3");
  assert.equal(both.get("2026-08-13"), 2); assert.equal(both.get("2026-08-12"), 1); assert.equal(both.get("2026-08-15"), 1);
  assert.equal(rescheduleCalendarCounts([]).size, 0, "tasks that were never moved contribute nothing");
});

test("summary: 10 tasks, 4 moved a total of 8 times → Tasks Rescheduled 4, Total Reschedules 8, average 0.8; empty population has no division error", () => {
  const task = (status: SummaryTask["status"], moves: number): SummaryTask => ({ status, moves, historyState: "COMPLETE" });
  const tasks = [task("COMPLETED", 3), task("PENDING", 2), task("OVERDUE", 2), task("PENDING", 1), ...Array.from({ length: 6 }, () => task("PENDING", 0))];
  const s = summarizeTasks(tasks);
  assert.deepEqual([s.total, s.rescheduledTasks, s.totalReschedules, s.averageReschedules], [10, 4, 8, 0.8]);
  assert.equal(s.completed + s.pending + s.overdue + s.cancelled, 10, "every task has exactly one status");
  assert.deepEqual([s.completed, s.pending, s.overdue, s.cancelled], [1, 8, 1, 0]);
  const empty = summarizeTasks([]);
  assert.deepEqual([empty.total, empty.averageReschedules, empty.rescheduledTasks], [0, 0, 0]);
  const legacy = summarizeTasks([task("PENDING", 1), { status: "PENDING", moves: 0, historyState: "UNAVAILABLE" }, { status: "OVERDUE", moves: 2, historyState: "PARTIAL" }]);
  assert.deepEqual([legacy.incompleteHistory, legacy.rescheduledTasks, legacy.totalReschedules, legacy.averageReschedules], [2, 2, 3, 1], "unknown legacy moves are not added; they are reported");
});

test("history preview: short histories show everything; long ones show the first and last steps with an explicit omitted count; full shows all", () => {
  const six = Array.from({ length: 6 }, (_, i) => `e${i}`);
  assert.equal(previewHistory(six.slice(0, 5), false).length, 5);
  const seg = previewHistory(six, false);
  assert.deepEqual(seg.map((s) => (s.kind === "event" ? s.event : `…${s.count}`)), ["e0", "e1", "…2", "e4", "e5"], "the 2 hidden moves are stated");
  assert.deepEqual(seg.filter((s) => s.kind === "event").map((s) => (s as { index: number }).index), [0, 1, 4, 5], "indexes keep their true position (non-adjacent steps are not renumbered)");
  assert.equal(previewHistory(six, true).length, 6);
  assert.equal(previewHistory([], false).length, 0);
});

test("filters: Tasks opens on Auto for the current month by Original Due Date; the date focus and page belong to the table only; month helpers", () => {
  const f = defaultTaskFilters("2026-10-15");
  assert.deepEqual([f.type, f.basis, f.from, f.to, f.focusDate, f.page], ["AUTO", "ORIGINAL", "2026-10-01", "2026-10-31", null, 1]);
  assert.equal(defaultTaskFilters("2026-10-15", "ALL").type, "ALL");
  const withFocus = { ...f, focusDate: "2026-10-16", page: 3, officerId: "so1", status: "OVERDUE" };
  assert.ok(taskQueryString(withFocus, "table").includes("focusDate=2026-10-16") && taskQueryString(withFocus, "table").includes("page=3"));
  const pop = taskQueryString(withFocus, "population");
  assert.ok(!pop.includes("focusDate") && !pop.includes("page") && pop.includes("officerId=so1") && pop.includes("status=OVERDUE") && pop.includes("basis=ORIGINAL"), "the calendar's population is never narrowed by its own selected date");
  assert.deepEqual(monthBounds("2026-02-10"), { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(shiftMonth("2026-12", 1), "2027-01"); assert.equal(shiftMonth("2026-01", -1), "2025-12");
});

test("intensity: one scale, 0 for nothing, the busiest date is the darkest; counts in between scale up", () => {
  assert.equal(intensityLevel(0, 5), 0); assert.equal(intensityLevel(5, 5), 5); assert.equal(intensityLevel(1, 5), 1); assert.equal(intensityLevel(1, 1), 5);
  const levels = [1, 2, 3, 4, 5].map((n) => intensityLevel(n, 5));
  assert.deepEqual(levels, [1, 2, 3, 4, 5]); assert.equal(intensityLevel(3, 0), 0);
});

console.log(`\n${passed} task-analysis rule tests passed`);
