/**
 * Canonical Scheme installment calculation tests (`scheme-installments.ts`). DB-free.
 *   npx tsx src/lib/scheme-installments.test.ts
 *
 * The invariant under test (Fixed AND Multiple Options):
 *   Booking Amount + Σ plannedAmount === applicable total Scheme Value (With GST)
 * Booking is deducted from the FINAL installment only; the final is never negative.
 */
import assert from "node:assert/strict";
import { normalInstallmentAmount, computeInstallmentAmounts, bookingExceedsFinalInstallment, effectiveBookingAmount, installmentValueColumns } from "./scheme-installments";

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

test("15. Balance calculates every option independently using one row percentage", () => {
  const columns = installmentValueColumns({ structure: "MULTIPLE_OPTIONS", achievementType: "QUANTITY_BASED", valueWithGST: 999, bookingAmount: 999,
    options: [{ target: 100, valueWithGST: 100000, bookingAmount: 25000 }, { target: 200, valueWithGST: 200000, bookingAmount: 35000 }, { target: 300, valueWithGST: 300000, bookingAmount: 50000 }] });
  assert.deepEqual(columns.map(c => c.header), ["Option 1", "Option 2", "Option 3"]);
  const rules = [pct(1, 30), pct(2, 70)];
  assert.deepEqual(columns.map(c => planned(computeInstallmentAmounts(rules, c.valueWithGST, c.bookingAmount, true))), [[30000, 45000], [60000, 105000], [90000, 160000]]);
});

test("15b. Options Amount shares non-final amounts and balances each option independently", () => {
  const columns = installmentValueColumns({ structure: "MULTIPLE_OPTIONS", achievementType: "VALUE_BASED", valueWithGST: 0, bookingAmount: 0,
    options: [{ target: null, valueWithGST: 100000, bookingAmount: 10000 }, { target: null, valueWithGST: 200000, bookingAmount: 20000 }] });
  const rules = [amt(1, 30000), amt(2, 0)];
  assert.deepEqual(columns.map(c => planned(computeInstallmentAmounts(rules, c.valueWithGST, c.bookingAmount, true))), [[30000, 60000], [30000, 150000]]);
  for (const [index, column] of columns.entries()) {
    approx(column.bookingAmount + sum(planned(computeInstallmentAmounts(rules, column.valueWithGST, column.bookingAmount, true))), column.valueWithGST, `option ${index + 1}`);
  }
});

test("16. Fixed creates exactly one With-GST value column regardless of basis", () => {
  for (const achievementType of ["PRODUCT_BASED", "VALUE_BASED", "NONE"]) {
    const cols = installmentValueColumns({ structure: "FIXED", achievementType, valueWithGST: 100000, bookingAmount: 25000, options: [] });
    assert.deepEqual(cols, [{ header: "Amount", valueWithGST: 100000, bookingAmount: 25000 }]);
  }
});

test("17. Value options use each With-GST value, never global or historical target", () => {
  const cols = installmentValueColumns({ structure: "MULTIPLE_OPTIONS", achievementType: "VALUE_BASED", valueWithGST: 999999, bookingAmount: 0,
    options: [{ target: 50000, valueWithGST: 23600, bookingAmount: 3600 }] });
  assert.equal(cols[0].header, "Option 1");
  assert.deepEqual(planned(computeInstallmentAmounts([pct(1, 100)], cols[0].valueWithGST, cols[0].bookingAmount, true)), [20000]);
});

test("18. Balance reconciles paise while default calculation preserves legacy rounding", () => {
  const rules = [pct(1, 50), pct(2, 50)];
  assert.deepEqual(planned(computeInstallmentAmounts(rules, 0.03, 0)), [0.02, 0.02]);
  assert.deepEqual(planned(computeInstallmentAmounts(rules, 0.03, 0, true)), [0.02, 0.01]);
  assert.equal(bookingExceedsFinalInstallment(rules, 0.03, 0.02, true), true);
  assert.equal(bookingExceedsFinalInstallment(rules, 0.03, 0.02), false);
});

test("19. Balance validation detects rounded over-allocation even without booking", () => {
  assert.equal(bookingExceedsFinalInstallment([pct(1, 50), pct(2, 50), pct(3, 0)], 0.01, 0, true), true);
  assert.equal(bookingExceedsFinalInstallment([pct(1, 80), pct(2, 20)], 100, 25, true), true);
});

test("20. Snapshot booking wins including zero; legacy null falls back to global", () => {
  assert.equal(effectiveBookingAmount("MULTIPLE_OPTIONS", 100, 0), 0);
  assert.equal(effectiveBookingAmount("MULTIPLE_OPTIONS", 100, 25), 25);
  assert.equal(effectiveBookingAmount("MULTIPLE_OPTIONS", 100, null), 100);
  assert.equal(effectiveBookingAmount("FIXED", 100, 25), 100);
});

test("21. Valid Balance schedules reconcile exactly at monetary precision", () => {
  for (const value of [0.03, 100.01, 23600.99, 300000]) {
    const rules = [pct(1, 30), pct(2, 20), pct(3, 50)];
    const booking = Math.round(value * 0.1 * 100) / 100;
    if (bookingExceedsFinalInstallment(rules, value, booking, true)) continue;
    const rows = computeInstallmentAmounts(rules, value, booking, true);
    assert.equal(Math.round((booking + sum(planned(rows))) * 100), Math.round(value * 100));
    assert.ok(rows.every(r => r.plannedAmount >= 0));
  }
});

console.log(`\n${passed} passed`);
