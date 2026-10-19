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
assert.equal(validateOutcome(f({ outcome: "ABANDONED" }), today), "reason_code_required", "a category is required");
assert.equal(validateOutcome(f({ outcome: "ABANDONED", reasonCode: "OTHER" }), today), "reason_required", "Other needs its explanation");
assert.equal(validateOutcome(f({ outcome: "ABANDONED", reasonCode: "OTHER", reason: "too short" }), today), "reason_short", "…which uses the existing free-text rules");
assert.equal(validateOutcome(f({ outcome: "ABANDONED", reasonCode: "OTHER", reason: "Dealer shifted to another territory entirely" }), today), null);
for (const code of ["PRODUCT_UNAVAILABLE", "DEALER_REFUSED", "NO_DUES"] as const) assert.equal(validateOutcome(f({ outcome: "ABANDONED", reasonCode: code }), today), null, `${code} is valid without any text (no 20-character minimum)`);
ok("per-outcome validation");

// Reasons: rule-based, whitespace/punctuation/repetition refused.
for (const bad of ["", "   \n  ", "....................", "!!!!!!!!!!!!!!!!!!!!!!", "aaaaaaaaaaaaaaaaaaaa", "asdf asdf asdf asdf", "too short", "x ".repeat(300)]) assert.notEqual(checkReason(bad), "ok", `reason ${JSON.stringify(bad.slice(0, 20))} refused`);
assert.equal(checkReason("Dealer closed the shop for the season and asked to drop this visit"), "ok");
assert.equal(checkReason("  Dealer   shifted   to   another   territory entirely  "), "ok");
ok("reason rules");

// Switching outcomes drops the other outcomes' fields.
assert.deepEqual(sanitizeOutcomeFields({ outcome: "RESCHEDULED", actualAmount: 500, nextDate: "2026-10-20", reason: "something long enough here" }), { ok: true, value: { outcome: "RESCHEDULED", actualAmount: null, nextDate: "2026-10-20", reason: null, reasonCode: null } });
assert.deepEqual(sanitizeOutcomeFields({ outcome: "COMPLETED", actualAmount: "700", nextDate: "2026-10-20", reason: "x" }), { ok: true, value: { outcome: "COMPLETED", actualAmount: 700, nextDate: null, reason: null, reasonCode: null } });
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
const unit = (p: Partial<UnitEdit>): UnitEdit => ({ unitType: "MANUAL_ROW", unitId: "u1", type: "MANUAL", source: null, plannedAmount: 500, outcome: "", actualAmount: "", nextDate: "", reason: "", reasonCode: "", state: "DRAFT", rescheduledFrom: null, dateRule: null, ...p });
assert.deepEqual(outcomeUnitsPayload([unit({})], today), [{ unitType: "MANUAL_ROW", unitId: "u1", outcome: null }], "starts unselected");
assert.deepEqual(outcomeUnitsPayload([unit({ outcome: "RESCHEDULED", nextDate: "2026-10-16", actualAmount: "5", reason: "x" })], today), [{ unitType: "MANUAL_ROW", unitId: "u1", outcome: "RESCHEDULED" }], "today is not a valid next date; stale fields not sent");
assert.deepEqual(outcomeUnitsPayload([unit({ outcome: "COMPLETED", actualAmount: "0" })], today), [{ unitType: "MANUAL_ROW", unitId: "u1", outcome: "COMPLETED" }], "zero is never sent as an amount");
assert.equal(outcomeUnitsPayload([unit({ state: "COMMITTED", outcome: "COMPLETED", actualAmount: "9" })], today).length, 0, "committed tasks are never re-sent");
assert.equal(rowActualOf([unit({ outcome: "COMPLETED", actualAmount: "250" })], today), 250);
assert.equal(rowActualOf([unit({ outcome: "COMPLETED", actualAmount: "0" })], today), null);
assert.equal(rowActualOf([], today), null);
ok("client payload");
// Abandonment categories: permitted per section, details of other categories are dropped, drafts may be incomplete.
import { abandonReasonsFor, isAbandonReasonAllowed } from "./task-outcome";
assert.deepEqual([...abandonReasonsFor("SALES")], ["PRODUCT_UNAVAILABLE", "DEALER_REFUSED", "OTHER"]);
assert.deepEqual([...abandonReasonsFor("RECOVERY")], ["NO_DUES", "OTHER"]);
assert.equal(isAbandonReasonAllowed("SALES", "NO_DUES"), false, "a Recovery reason is not valid for Sales");
assert.equal(isAbandonReasonAllowed("RECOVERY", "DEALER_REFUSED"), false, "a Sales reason is not valid for Recovery");
assert.equal(isAbandonReasonAllowed("RECOVERY", "OTHER"), true);
assert.deepEqual(sanitizeOutcomeFields({ outcome: "ABANDONED", reasonCode: "NO_DUES", reason: "left over text here please" }, "RECOVERY"), { ok: true, value: { outcome: "ABANDONED", actualAmount: null, nextDate: null, reason: null, reasonCode: "NO_DUES" } });
assert.deepEqual(sanitizeOutcomeFields({ outcome: "ABANDONED", reasonCode: "OTHER", reason: "  Dealer   closed  the shop  " }, "SALES"), { ok: true, value: { outcome: "ABANDONED", actualAmount: null, nextDate: null, reason: "Dealer closed the shop", reasonCode: "OTHER" } });
assert.equal(sanitizeOutcomeFields({ outcome: "ABANDONED", reasonCode: "NO_DUES" }, "SALES").ok, false, "a Sales row refuses a Recovery code");
assert.equal(sanitizeOutcomeFields({ outcome: "ABANDONED", reasonCode: "bogus" }, "SALES").ok, false);
assert.deepEqual(sanitizeOutcomeFields({ outcome: "ABANDONED" }, "SALES"), { ok: true, value: { outcome: "ABANDONED", actualAmount: null, nextDate: null, reason: null, reasonCode: null } }, "a draft may keep an unselected category");
assert.deepEqual(sanitizeOutcomeFields({ outcome: "COMPLETED", actualAmount: 5, reasonCode: "OTHER", reason: "stale text stale text" }, "SALES"), { ok: true, value: { outcome: "COMPLETED", actualAmount: 5, nextDate: null, reason: null, reasonCode: null } }, "leaving Abandon clears the abandonment-only fields");
console.log("task-outcome.test.ts — all assertions passed");
