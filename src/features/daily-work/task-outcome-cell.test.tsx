/** Daily Report outcome cell: the Actual Amount is ALWAYS shown beside the outcome; only Completed enables it; leaving Completed clears it. No DB / browser. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { readFileSync } from "node:fs";

const selects: { onChange: (e: { target: { value: string } }) => void }[] = [];
const load = testLoader({
  "@/features/labels/label-ui": { useLabel: (key: LabelKey) => DEFAULT_LABELS[key] },
  "@/components/ui/select": { NativeSelect: (p: { onChange: (e: { target: { value: string } }) => void; value: string; disabled?: boolean }) => { selects.push(p); return <select data-value={p.value} disabled={p.disabled} />; } },
});
const { TaskOutcomeCell, outcomeUnitsPayload } = load<typeof import("./task-outcome-cell")>("src/features/daily-work/task-outcome-cell.tsx");
const unit = (over: Record<string, unknown> = {}) => ({ unitType: "MANUAL_ROW", unitId: "u1", type: "MANUAL", source: null, plannedAmount: 500, outcome: "", actualAmount: "", nextDate: "", reason: "", state: "DRAFT", rescheduledFrom: null, dateRule: null, ...over });
const render = (u: ReturnType<typeof unit>, disabled = false) => { selects.length = 0; return renderToStaticMarkup(<TaskOutcomeCell units={[u as never]} rowLabel="A very long dealer name Traders & Sons Private Limited" today="2026-10-05" disabled={disabled} onChange={() => {}} />); };
const amountInput = (h: string) => h.match(/<input[^>]*type="number"[^>]*>/)?.[0] ?? "";

// Visible for every state; enabled only for Completed; the placeholder is the agreed text.
for (const [outcome, enabled] of [["", false], ["COMPLETED", true], ["RESCHEDULED", false], ["ABANDONED", false]] as const) {
  const h = render(unit({ outcome, actualAmount: outcome === "COMPLETED" ? "10000000.50" : "" }));
  const input = amountInput(h);
  assert.ok(input !== "", `amount input visible for ${JSON.stringify(outcome)}`);
  assert.equal(/ disabled=""/.test(input), !enabled, `enabled only for Completed (${JSON.stringify(outcome)})`);
  assert.ok(input.includes('placeholder="Enter actual amount"'), "placeholder text");
  assert.ok(input.includes("min-w-[160px]"), "practical minimum width, never a narrow spinner box");
  assert.ok(h.indexOf("<select") < h.indexOf('type="number"') && h.indexOf('type="number"') < (h.indexOf('data-testid="outcome-date"') + 1 || Infinity), "the amount sits beside the dropdown, before the date / reason control");
}
assert.ok(amountInput(render(unit({ outcome: "COMPLETED", actualAmount: "10000000.50" }))).includes('value="10000000.50"'), "a large amount is held in full");
// Date / reason controls are separate from the amount, which stays visible.
const resched = render(unit({ outcome: "RESCHEDULED", nextDate: "2026-10-09" }));
assert.ok(resched.includes('data-testid="outcome-date"') && amountInput(resched) !== "");
const abandon = render(unit({ outcome: "ABANDONED", reason: "closed the shop" }));
assert.ok(abandon.includes('data-testid="outcome-reason"') && amountInput(abandon) !== "");
// Locked views stay read-only whatever the outcome; a committed task shows its result and a disabled amount.
assert.ok(/ disabled=""/.test(amountInput(render(unit({ outcome: "COMPLETED", actualAmount: "5" }), true))), "a locked view disables the amount even for Completed");
const done = render(unit({ outcome: "COMPLETED", actualAmount: "700", state: "COMMITTED" }));
assert.ok(/ disabled=""/.test(amountInput(done)) && done.includes('data-testid="outcome-result"'), "committed: read-only amount + result");
// Leaving Completed clears the amount; choosing Completed does not invent one.
render(unit({ outcome: "COMPLETED", actualAmount: "250" }));
const patches: Record<string, unknown>[] = [];
selects.length = 0;
renderToStaticMarkup(<TaskOutcomeCell units={[unit({ outcome: "COMPLETED", actualAmount: "250" }) as never]} rowLabel="x" today="2026-10-05" disabled={false} onChange={(_id, patch) => patches.push(patch)} />);
selects[0]!.onChange({ target: { value: "RESCHEDULED" } });
selects[0]!.onChange({ target: { value: "ABANDONED" } });
selects[0]!.onChange({ target: { value: "COMPLETED" } });
assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ outcome: "RESCHEDULED", actualAmount: "" }, { outcome: "ABANDONED", actualAmount: "" }, { outcome: "COMPLETED" }]);
// The payload never carries an amount for another outcome, and never replaces it by zero.
assert.deepEqual(JSON.parse(JSON.stringify(outcomeUnitsPayload([unit({ outcome: "RESCHEDULED", actualAmount: "250", nextDate: "2026-10-09" }) as never], "2026-10-05"))), [{ unitType: "MANUAL_ROW", unitId: "u1", outcome: "RESCHEDULED", nextDate: "2026-10-09" }]);

// Table layout: Dealer wraps and the outcome column is wide (static wiring of the page).
const page = readFileSync("src/features/daily-work/daily-work-page.tsx", "utf8");
assert.ok(page.includes('data-testid="report-columns"') && page.includes('<col className="w-[440px]" />') && page.includes('<col className="w-[190px]" />'), "report colgroup: compact Dealer, wide outcome column");
assert.ok(page.includes("(compactRecovery || showResults) && \"break-words\""), "long dealer names wrap");
console.log("task-outcome-cell.test.tsx — all assertions passed");
