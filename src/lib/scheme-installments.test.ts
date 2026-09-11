/**
 * Canonical Scheme installment calculation tests (`scheme-installments.ts`). DB-free.
 *   npx tsx src/lib/scheme-installments.test.ts
 *
 * The invariant under test (Fixed AND Multiple Options):
 *   Booking Amount + Σ plannedAmount === applicable total Scheme Value (With GST)
 * Booking is deducted from the FINAL installment only; the final is never negative.
 */
import assert from "node:assert/strict";
import { normalInstallmentAmount, computeInstallmentAmounts, bookingExceedsFinalInstallment } from "./scheme-installments";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }
const approx = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 0.005, `${msg ?? ""} expected ${b}, got ${a}`);

const pct = (installmentNumber: number, value: number) => ({ installmentNumber, calculationType: "PERCENTAGE", value });
const amt = (installmentNumber: number, value: number) => ({ installmentNumber, calculationType: "FIXED_AMOUNT", value });
const planned = (rows: ReturnType<typeof computeInstallmentAmounts>) => rows.map((r) => r.plannedAmount);
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

/* ---------- 1–4: Percentage mode ---------- */

test("1. Percentage mode WITHOUT booking → straight amounts", () => {
  const r = computeInstallmentAmounts([pct(1, 30), pct(2, 30), pct(3, 40)], 100000, 0);
  assert.deepEqual(planned(r), [30000, 30000, 40000]);
  approx(sum(planned(r)), 100000);
});

test("2. Percentage mode WITH booking → only the FINAL is reduced (30/30/40 → 30/30/30)", () => {
  const r = computeInstallmentAmounts([pct(1, 30), pct(2, 30), pct(3, 40)], 100000, 10000);
  assert.deepEqual(planned(r), [30000, 30000, 30000]);
  approx(10000 + sum(planned(r)), 100000, "booking + installments");
});

test("3. Percentage final-installment deduction: percentage stays 40%, amount becomes 30,000", () => {
  const r = computeInstallmentAmounts([pct(1, 30), pct(2, 30), pct(3, 40)], 100000, 10000);
  approx(r[2].normalAmount, 40000);   // 40% of the FULL value — unchanged
  approx(r[2].plannedAmount, 30000);  // amount reduced by the booking
});

test("4. Percentage amount column values (auto-final 25/25/50 with booking)", () => {
  const r = computeInstallmentAmounts([pct(1, 25), pct(2, 25), pct(3, 50)], 100000, 10000);
  assert.deepEqual(planned(r), [25000, 25000, 40000]); // 50,000 − 10,000 = 40,000
  approx(10000 + sum(planned(r)), 100000);
});

/* ---------- 5–7: Amount mode ---------- */

test("5. Amount mode WITHOUT booking → amounts unchanged", () => {
  const r = computeInstallmentAmounts([amt(1, 30000), amt(2, 30000), amt(3, 40000)], 100000, 0);
  assert.deepEqual(planned(r), [30000, 30000, 40000]);
});

test("6. Amount mode WITH booking → final reduced (rules sum to full value, final = balance)", () => {
  // Rules store the NORMAL balancing final (40,000); booking is deducted at calc → 30,000.
  const r = computeInstallmentAmounts([amt(1, 30000), amt(2, 30000), amt(3, 40000)], 100000, 10000);
  assert.deepEqual(planned(r), [30000, 30000, 30000]);
  approx(10000 + sum(planned(r)), 100000);
});

test("7. Final amount balances the total after booking", () => {
  const r = computeInstallmentAmounts([amt(1, 20000), amt(2, 20000), amt(3, 60000)], 100000, 15000);
  approx(r[2].plannedAmount, 45000); // 60,000 − 15,000
  approx(15000 + sum(planned(r)), 100000);
});

/* ---------- 8: Booking = 0 ---------- */

test("8. Booking = 0 → no deduction anywhere (both modes)", () => {
  assert.deepEqual(planned(computeInstallmentAmounts([pct(1, 50), pct(2, 50)], 80000, 0)), [40000, 40000]);
  assert.deepEqual(planned(computeInstallmentAmounts([amt(1, 40000), amt(2, 40000)], 80000, 0)), [40000, 40000]);
});

/* ---------- 9–10: Multiple Options (per selected option value) ---------- */

test("9. Multiple Options — final reduced against the SELECTED option value (50k, booking 5k)", () => {
  const r = computeInstallmentAmounts([pct(1, 50), pct(2, 50)], 50000, 5000);
  assert.deepEqual(planned(r), [25000, 20000]); // 25,000 + (25,000 − 5,000)
  approx(5000 + sum(planned(r)), 50000);
});

test("10. Different selected option values reconcile independently", () => {
  for (const [val, booking] of [[50000, 5000], [23600, 2000], [11800, 1000]] as const) {
    const r = computeInstallmentAmounts([pct(1, 40), pct(2, 60)], val, booking);
    approx(booking + sum(planned(r)), val, `option value ${val}`);
    assert.ok(r[1].plannedAmount >= 0);
  }
});

/* ---------- 11: Schedule/installment creation shape (one installment) ---------- */

test("11. Single installment = the final → full value minus booking", () => {
  const r = computeInstallmentAmounts([pct(1, 100)], 100000, 10000);
  assert.deepEqual(planned(r), [90000]);
  approx(10000 + sum(planned(r)), 100000);
  // Amount-mode single installment behaves the same.
  assert.deepEqual(planned(computeInstallmentAmounts([amt(1, 100000)], 100000, 10000)), [90000]);
});

/* ---------- 12: Never-negative final + validation guard ---------- */

test("12. Final never negative; bookingExceedsFinalInstallment flags an over-large booking", () => {
  // Booking greater than the final normal (40% of 100k = 40k): clamped to 0, and flagged invalid.
  const r = computeInstallmentAmounts([pct(1, 60), pct(2, 40)], 100000, 50000);
  assert.equal(r[1].plannedAmount, 0); // clamped, never negative
  assert.equal(bookingExceedsFinalInstallment([pct(1, 60), pct(2, 40)], 100000, 50000), true);
  assert.equal(bookingExceedsFinalInstallment([pct(1, 60), pct(2, 40)], 100000, 40000), false); // exactly the final → allowed
  assert.equal(bookingExceedsFinalInstallment([pct(1, 60), pct(2, 40)], 100000, 0), false);
});

/* ---------- 13: Final total reconciliation (the core invariant) ---------- */

test("13. Booking + all installments === applicable total (percentage & amount, several shapes)", () => {
  const cases: Array<[ReturnType<typeof pct>[], number, number]> = [
    [[pct(1, 30), pct(2, 30), pct(3, 40)], 100000, 10000],
    [[pct(1, 20), pct(2, 20), pct(3, 20), pct(4, 40)], 250000, 25000],
    [[amt(1, 30000), amt(2, 70000)], 100000, 7500],
    [[pct(1, 100)], 60000, 0],
  ];
  for (const [rules, value, booking] of cases) {
    const r = computeInstallmentAmounts(rules, value, booking);
    approx(booking + sum(planned(r)), value, `value ${value}, booking ${booking}`);
  }
});

/* ---------- normalInstallmentAmount direct ---------- */

test("14. normalInstallmentAmount: percentage vs fixed", () => {
  approx(normalInstallmentAmount(pct(1, 40), 100000), 40000);
  approx(normalInstallmentAmount(amt(1, 12345), 100000), 12345);
});

console.log(`\n${passed} passed`);
