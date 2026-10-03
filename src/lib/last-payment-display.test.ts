/**
 * Tests for the Recovery "Last Payment" fallback label decision.
 *   npx tsx src/lib/last-payment-display.test.ts
 *
 * The SAME pure function drives Month View and Week View (both call LastPaymentCell → lastPaymentDisplay),
 * so these cases cover both views consistently.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lastPaymentDisplay } from "./last-payment-display";

let pass = 0;
const t = (name: string, fn: () => void) => { fn(); pass++; console.log(`  ok  ${name}`); };

// 1. Positive Current Outstanding + missing Last Payment → fallback decision (text lives in labels).
t("positive outstanding + no receipt → fallback", () => {
  assert.deepEqual(lastPaymentDisplay({ date: null, amount: null, outstanding: 1500 }), { kind: "fallback" });
});

// 1b. The fallback TEXT is defined in the label dictionary as "Before 01/04/2026".
t("label dictionary defines recovery.lastPaymentFallback = 'Before 01/04/2026'", () => {
  const labels = readFileSync(resolve("src/features/labels/labels.ts"), "utf8");
  assert.ok(/"recovery\.lastPaymentFallback":\s*"Before 01\/04\/2026"/.test(labels), "label key present with expected text");
});

// 2a. Zero Current Outstanding + missing Last Payment → existing empty display.
t("zero outstanding + no receipt → empty (existing dash)", () => {
  assert.deepEqual(lastPaymentDisplay({ date: null, amount: null, outstanding: 0 }), { kind: "empty" });
});

// 2b. Negative Current Outstanding + missing Last Payment → existing empty display.
t("negative outstanding + no receipt → empty (existing dash)", () => {
  assert.deepEqual(lastPaymentDisplay({ date: null, amount: null, outstanding: -2500 }), { kind: "empty" });
});

// 3. An actual Last Payment → real date + amount, never the fallback (regardless of outstanding).
t("receipt present → real date + amount (not fallback)", () => {
  assert.deepEqual(
    lastPaymentDisplay({ date: "2026-06-06", amount: 5000, outstanding: 1500 }),
    { kind: "real", date: "2026-06-06", amount: 5000 },
  );
  // Receipt wins even when outstanding is 0.
  assert.deepEqual(
    lastPaymentDisplay({ date: "2026-05-12", amount: 10000, outstanding: 0 }),
    { kind: "real", date: "2026-05-12", amount: 10000 },
  );
});

// 4. After a valid receipt becomes available (existing data flow sets date), the fallback is replaced.
t("fallback is replaced once a receipt becomes available", () => {
  const before = lastPaymentDisplay({ date: null, amount: null, outstanding: 1500 });
  assert.equal(before.kind, "fallback");
  const after = lastPaymentDisplay({ date: "2026-07-01", amount: 3200, outstanding: 1500 });
  assert.deepEqual(after, { kind: "real", date: "2026-07-01", amount: 3200 });
});

// 5. Month View and Week View consistency — identical inputs yield identical decisions (same function).
t("Month View and Week View decide identically for identical inputs", () => {
  const input = { date: null, amount: null, outstanding: 999 };
  assert.deepEqual(lastPaymentDisplay({ ...input }), lastPaymentDisplay({ ...input }));
});

// Edge: a receipt with a null amount still renders as real with amount 0 (unchanged pre-existing behaviour).
t("receipt date with null amount → real, amount 0", () => {
  assert.deepEqual(lastPaymentDisplay({ date: "2026-04-10", amount: null, outstanding: 50 }), { kind: "real", date: "2026-04-10", amount: 0 });
});

console.log(`\n${pass} last-payment-display tests passed`);
