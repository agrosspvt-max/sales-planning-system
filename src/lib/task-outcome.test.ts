/** Pure rules of the Daily Report task outcome workflow (no database). */
import assert from "node:assert/strict";
import { checkReason, isOutcomeComplete, parseActualAmount, rowActualFromOutcomes, sanitizeOutcomeFields, validateOutcome, type OutcomeFields } from "./task-outcome";
import { outcomeUnitsPayload, rowActualOf, type UnitEdit } from "@/features/daily-work/task-outcome-cell";

const today = "2026-10-16";
const f = (o: Partial<OutcomeFields>): OutcomeFields => ({ outcome: null, actualAmount: null, nextDate: null, reason: null, ...o });
const ok = (name: string) => console.log(`  ok - ${name}`);

// Amount: strictly positive, 2-decimal precision, bounded; nothing invalid is silently turned into 0.
for (const bad of [0, "0", "0.00", "0.004", -1, "-5", "abc", "1e3", NaN, Infinity, 1e12 + 1]) assert.equal(parseActualAmount(bad).ok, false, `amount ${String(bad)} rejected`);
assert.deepEqual(parseActualAmount(""), { ok: true, value: null });
assert.deepEqual(parseActualAmount("1250.456"), { ok: true, value: 1250.46 });
assert.deepEqual(parseActualAmount(0.01), { ok: true, value: 0.01 });
ok("amount rules");

// Final validation per outcome.
assert.equal(validateOutcome(f({}), today), "outcome_required");
assert.equal(validateOutcome(f({ outcome: "COMPLETED" }), today), "amount_required");
assert.equal(validateOutcome(f({ outcome: "COMPLETED", actualAmount: 0 }), today), "amount_invalid");
assert.equal(validateOutcome(f({ outcome: "COMPLETED", actualAmount: 1 }), today), null);
assert.equal(validateOutcome(f({ outcome: "COMPLETED", actualAmount: 1 }), today), null, "no Actual >= Planned rule exists");
assert.equal(validateOutcome(f({ outcome: "RESCHEDULED" }), today), "date_required");
assert.equal(validateOutcome(f({ outcome: "RESCHEDULED", nextDate: today }), today), "date_not_future");
assert.equal(validateOutcome(f({ outcome: "RESCHEDULED", nextDate: "2026-10-15" }), today), "date_not_future");
assert.equal(validateOutcome(f({ outcome: "RESCHEDULED", nextDate: "2026-02-30" }), today), "date_invalid");
assert.equal(validateOutcome(f({ outcome: "RESCHEDULED", nextDate: "2026-10-17" }), today), null);
assert.equal(validateOutcome(f({ outcome: "ABANDONED" }), today), "reason_required");
ok("per-outcome validation");

// Reasons: rule-based, whitespace/punctuation/repetition refused.
for (const bad of ["", "   \n  ", "....................", "!!!!!!!!!!!!!!!!!!!!!!", "aaaaaaaaaaaaaaaaaaaa", "asdf asdf asdf asdf", "too short", "x ".repeat(300)]) assert.notEqual(checkReason(bad), "ok", `reason ${JSON.stringify(bad.slice(0, 20))} refused`);
assert.equal(checkReason("Dealer closed the shop for the season and asked to drop this visit"), "ok");
assert.equal(checkReason("  Dealer   shifted   to   another   territory entirely  "), "ok");
ok("reason rules");

// Switching outcomes drops the other outcomes' fields.
assert.deepEqual(sanitizeOutcomeFields({ outcome: "RESCHEDULED", actualAmount: 500, nextDate: "2026-10-20", reason: "something long enough here" }), { ok: true, value: { outcome: "RESCHEDULED", actualAmount: null, nextDate: "2026-10-20", reason: null } });
assert.deepEqual(sanitizeOutcomeFields({ outcome: "COMPLETED", actualAmount: "700", nextDate: "2026-10-20", reason: "x" }), { ok: true, value: { outcome: "COMPLETED", actualAmount: 700, nextDate: null, reason: null } });
assert.equal(sanitizeOutcomeFields({ outcome: "bogus" }).ok, false);
assert.equal(sanitizeOutcomeFields({ outcome: "COMPLETED", actualAmount: "-3" }).ok, false);
ok("fields of other outcomes are cleared");

// Row total: null until every task has a valid outcome; only Completed amounts count.
const done = f({ outcome: "COMPLETED", actualAmount: 300 });
const resch = f({ outcome: "RESCHEDULED", nextDate: "2026-10-20" });
assert.equal(rowActualFromOutcomes([done, f({})], today), null);
assert.equal(rowActualFromOutcomes([done, resch], today), 300);
assert.equal(rowActualFromOutcomes([resch], today), 0);
assert.equal(isOutcomeComplete(done, today), true);
ok("row total");

// Client payload carries only the chosen outcome's valid fields, and rows total identically to the server.
const unit = (p: Partial<UnitEdit>): UnitEdit => ({ unitType: "MANUAL_ROW", unitId: "u1", type: "MANUAL", source: null, plannedAmount: 500, outcome: "", actualAmount: "", nextDate: "", reason: "", state: "DRAFT", rescheduledFrom: null, dateRule: null, ...p });
assert.deepEqual(outcomeUnitsPayload([unit({})], today), [{ unitType: "MANUAL_ROW", unitId: "u1", outcome: null }], "starts unselected");
assert.deepEqual(outcomeUnitsPayload([unit({ outcome: "RESCHEDULED", nextDate: "2026-10-16", actualAmount: "5", reason: "x" })], today), [{ unitType: "MANUAL_ROW", unitId: "u1", outcome: "RESCHEDULED" }], "today is not a valid next date; stale fields not sent");
assert.deepEqual(outcomeUnitsPayload([unit({ outcome: "COMPLETED", actualAmount: "0" })], today), [{ unitType: "MANUAL_ROW", unitId: "u1", outcome: "COMPLETED" }], "zero is never sent as an amount");
assert.equal(outcomeUnitsPayload([unit({ state: "COMMITTED", outcome: "COMPLETED", actualAmount: "9" })], today).length, 0, "committed tasks are never re-sent");
assert.equal(rowActualOf([unit({ outcome: "COMPLETED", actualAmount: "250" })], today), 250);
assert.equal(rowActualOf([unit({ outcome: "COMPLETED", actualAmount: "0" })], today), null);
assert.equal(rowActualOf([], today), null);
ok("client payload");
console.log("task-outcome.test.ts — all assertions passed");
