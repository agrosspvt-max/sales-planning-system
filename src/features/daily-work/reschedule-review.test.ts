/** Daily Work Review → rescheduling assembly: scheduled-date history vs actions performed, stable identity, continuations, history-only tasks. No database. */
import assert from "node:assert/strict";
import { buildReschedulingReview, type RescheduleEventInput, type TaskDescriptor } from "./reschedule-review";

const ev = (id: string, sourceId: string, previousDate: string, newDate: string, createdAt: string, o: Partial<RescheduleEventInput> = {}): RescheduleEventInput => ({
  id, sourceType: "CALENDAR_ENTRY", sourceId, ownerId: "so1", previousDate, newDate, actorName: "Asha", reason: null, createdAt,
  actionDate: new Date(new Date(createdAt).getTime() + 330 * 60_000).toISOString().slice(0, 10), ...o,
});
const complete: TaskDescriptor = { dealerName: "Alpha", marketName: null, description: "Collect", section: "RECOVERY", historyState: "COMPLETE" };
const descriptors = new Map<string, TaskDescriptor>([["CALENDAR_ENTRY:t1", complete], ["CALENDAR_ENTRY:t2", { ...complete, dealerName: "Beta" }], ["BILLING_EXCEPTION:b1", { ...complete, dealerName: "Gamma", historyState: "PARTIAL" }]]);
const row = (entryId: string, ...units: [string, string][]) => ({ entryId, units: units.map(([unitType, unitId]) => ({ unitType, unitId })) });
const none = new Map<string, { type: string; id: string }>();
const build = (date: string, events: RescheduleEventInput[], rows = [row("r", ["CALENDAR_ENTRY", "t1"])], continuations = none, d = descriptors) =>
  buildReschedulingReview({ officerId: "so1", date, events, descriptors: d, rows, continuations });

// One task moved 22 → 23 → 24 (both moves performed on the 22nd, in IST).
const chain = [ev("e1", "t1", "2026-10-22", "2026-10-23", "2026-10-22T04:00:00Z"), ev("e2", "t1", "2026-10-23", "2026-10-24", "2026-10-22T05:00:00Z")];
{
  const d22 = build("2026-10-22", chain).rows.r![0]!;
  assert.deepEqual([d22.from, d22.to, d22.count], [null, "2026-10-23", 2], "22nd: evidence of the move to the 23rd; lifetime count 2");
  const d23 = build("2026-10-23", chain).rows.r![0]!;
  assert.deepEqual([d23.from, d23.to, d23.count], ["2026-10-22", "2026-10-24", 2], "23rd: arrived from the 22nd AND moved on to the 24th");
  const d24 = build("2026-10-24", chain).rows.r![0]!;
  assert.deepEqual([d24.from, d24.to, d24.count], ["2026-10-23", null, 2], "24th: arrived from the 23rd; its latest date is not presented as the original");
}
// Actions are about WHEN the change was made, not the scheduled dates: both moves are on the 22nd (action date), none on the 23rd or 24th.
{
  const a22 = build("2026-10-22", chain).actions;
  assert.deepEqual(a22.map((a) => [a.previousDate, a.newDate, a.actorName, a.dealerName, a.section]), [["2026-10-22", "2026-10-23", "Asha", "Alpha", "RECOVERY"], ["2026-10-23", "2026-10-24", "Asha", "Alpha", "RECOVERY"]], "two moves of one task on one day → two events");
  assert.equal(build("2026-10-23", chain).actions.length, 0, "no action was performed on the 23rd although the task was scheduled there");
}
// IST action date: 20:00 UTC on the 22nd is already the 23rd in Kolkata.
{
  const late = [ev("l1", "t1", "2026-10-25", "2026-10-26", "2026-10-22T20:00:00Z")];
  assert.equal(late[0]!.actionDate, "2026-10-23");
  assert.equal(build("2026-10-22", late, []).actions.length, 0);
  assert.equal(build("2026-10-23", late, []).actions.length, 1, "the Asia/Kolkata business date decides");
}
// Another employee's events never appear as this employee's actions.
assert.equal(build("2026-10-22", [ev("o1", "t2", "2026-10-22", "2026-10-23", "2026-10-22T04:00:00Z", { ownerId: "so9" })], []).actions.length, 0);
// Counts are per task: two unrelated tasks of one dealer are never summed.
{
  const two = [...chain, ev("x1", "t2", "2026-10-23", "2026-10-24", "2026-10-23T04:00:00Z")];
  const r = build("2026-10-23", two, [row("a", ["CALENDAR_ENTRY", "t1"]), row("b", ["CALENDAR_ENTRY", "t2"])]);
  assert.deepEqual([r.rows.a![0]!.count, r.rows.b![0]!.count], [2, 1]);
}
// A row whose task never moved carries nothing; no duplicates between the table and the history-only list.
{
  const r = build("2026-10-23", chain, [row("r", ["CALENDAR_ENTRY", "t1"]), row("plain", ["CALENDAR_ENTRY", "t9"])]);
  assert.deepEqual(Object.keys(r.rows), ["r"]);
  assert.equal(r.tasks.length, 0, "a task shown in the table is not repeated as history-only");
}
// A task whose current link changed (no row for it on the reviewed date) is still represented — history only.
{
  const r = build("2026-10-22", chain, []);
  assert.deepEqual(r.tasks.map((t) => [t.key, t.from, t.to, t.count]), [["CALENDAR_ENTRY:t1", null, "2026-10-23", 2]]);
  assert.deepEqual(build("2026-10-25", chain, []).tasks, [], "dates the task never touched list nothing");
}
// Manual row that continued as a Calendar task: the outgoing manual row follows the continuation.
{
  const cont = [ev("c1", "t1", "2026-10-22", "2026-10-23", "2026-10-22T04:00:00Z")];
  const r = build("2026-10-22", cont, [row("manual", ["MANUAL_ROW", "manual"])], new Map([["manual", { type: "CALENDAR_ENTRY", id: "t1" }]]));
  assert.deepEqual([r.rows.manual![0]!.to, r.rows.manual![0]!.count], ["2026-10-23", 1]);
  assert.equal(r.tasks.length, 0);
  assert.equal(build("2026-10-22", cont, [row("manual", ["MANUAL_ROW", "manual"])]).rows.manual, undefined, "no continuation recorded → nothing is invented");
}
// Legacy / incomplete history: flagged "recorded only", counts and dates are only what was recorded.
{
  const b = buildReschedulingReview({ officerId: "so1", date: "2026-10-23", events: [ev("g1", "b1", "2026-10-22", "2026-10-23", "2026-10-22T04:00:00Z", { sourceType: "BILLING_EXCEPTION" })], descriptors, rows: [row("g", ["BILLING_EXCEPTION", "b1"])], continuations: none });
  assert.deepEqual([b.rows.g![0]!.recordedOnly, b.rows.g![0]!.count, b.rows.g![0]!.from], [true, 1, "2026-10-22"]);
  const missing = build("2026-10-23", chain, [row("r", ["CALENDAR_ENTRY", "t1"])], none, new Map());
  assert.equal(missing.rows.r![0]!.recordedOnly, true, "an undescribable task is shown as recorded-only, never fabricated");
}
console.log("reschedule-review.test.ts — all assertions passed");
