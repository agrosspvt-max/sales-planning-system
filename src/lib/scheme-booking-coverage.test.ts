/**
 * Booking-coverage logic tests (`scheme-booking-coverage.ts`). DB-free.
 *   npx tsx src/lib/scheme-booking-coverage.test.ts
 *
 * Business case: 3 schemes × ₹10,000, booking ₹1,000/scheme. Admin selects how many the Paid booking covers.
 */
import assert from "node:assert/strict";
import { bookingCoverage, bookingCoverageUnits } from "./scheme-booking-coverage";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const base = { plannedSchemes: 3, bookingPerScheme: 1000 };

/* ---------- selection range ---------- */
test("selected 0 → invalid", () => {
  const r = bookingCoverage({ ...base, selectedCount: 0, receivedAmount: 0 });
  assert.equal(r.valid, false);
  assert.match(r.error!, /number of schemes/i);
});
test("selected > planned (4 of 3) → invalid", () => {
  const r = bookingCoverage({ ...base, selectedCount: 4, receivedAmount: 4000 });
  assert.equal(r.valid, false);
  assert.match(r.error!, /at most 3/);
});

/* ---------- required amount + sufficiency ---------- */
test("1 of 3: required ₹1,000; exact → valid, excess 0", () => {
  const r = bookingCoverage({ ...base, selectedCount: 1, receivedAmount: 1000 });
  assert.deepEqual([r.requiredAmount, r.excessAmount, r.valid], [1000, 0, true]);
});
test("2 of 3: required ₹2,000; received ₹1,500 (short) → invalid", () => {
  const r = bookingCoverage({ ...base, selectedCount: 2, receivedAmount: 1500 });
  assert.equal(r.requiredAmount, 2000);
  assert.equal(r.valid, false);
  assert.match(r.error!, /short of the required 2000 for 2 schemes/);
});
test("2 of 3: required ₹2,000; received ₹2,000 (exact) → valid, excess 0", () => {
  const r = bookingCoverage({ ...base, selectedCount: 2, receivedAmount: 2000 });
  assert.deepEqual([r.requiredAmount, r.excessAmount, r.valid], [2000, 0, true]);
});
test("2 of 3: required ₹2,000; received ₹2,500 (excess) → valid, excess ₹500", () => {
  const r = bookingCoverage({ ...base, selectedCount: 2, receivedAmount: 2500 });
  assert.deepEqual([r.requiredAmount, r.excessAmount, r.valid], [2000, 500, true]);
});
test("3 of 3: required ₹3,000; received ₹3,000 → valid (all schemes covered)", () => {
  const r = bookingCoverage({ ...base, selectedCount: 3, receivedAmount: 3000 });
  assert.deepEqual([r.requiredAmount, r.excessAmount, r.valid], [3000, 0, true]);
});
test("excess does not change coverage: 2 selected stays 2 even at ₹2,500", () => {
  // The count is the explicit selection; the excess never bumps coverage to 3.
  const r = bookingCoverage({ ...base, selectedCount: 2, receivedAmount: 2500 });
  assert.equal(r.valid, true);
  assert.equal(r.excessAmount, 500);
});
test("decimal-safe required/excess", () => {
  const r = bookingCoverage({ plannedSchemes: 2, bookingPerScheme: 333.33, selectedCount: 2, receivedAmount: 700 });
  assert.equal(r.requiredAmount, 666.66);
  assert.equal(r.excessAmount, 33.34);
  assert.equal(r.valid, true);
});

/* ---------- follow-up coverage units (+ historical fallback) ---------- */
test("units: explicit count wins (2 of 3)", () => {
  assert.equal(bookingCoverageUnits({ adminBookingSchemeCount: 2, adminBookingStatus: "RECEIVED", numberOfSchemes: 3 }), 2);
});
test("units: explicit 3 → 3", () => {
  assert.equal(bookingCoverageUnits({ adminBookingSchemeCount: 3, adminBookingStatus: "RECEIVED", numberOfSchemes: 3 }), 3);
});
test("units: historical Paid plan (no count) covers all its schemes", () => {
  assert.equal(bookingCoverageUnits({ adminBookingSchemeCount: null, adminBookingStatus: "RECEIVED", numberOfSchemes: 3 }), 3);
});
test("units: non-Paid / unverified plan covers 0", () => {
  assert.equal(bookingCoverageUnits({ adminBookingSchemeCount: null, adminBookingStatus: "PARTIAL", numberOfSchemes: 3 }), 0);
  assert.equal(bookingCoverageUnits({ adminBookingSchemeCount: null, adminBookingStatus: null, numberOfSchemes: 3 }), 0);
});

console.log(`\n${passed} scheme booking-coverage tests passed`);
