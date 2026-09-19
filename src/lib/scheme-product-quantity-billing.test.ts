/**
 * Product-Quantity-Based billing logic tests (`scheme-product-quantity-billing.ts`). DB-free.
 *   npx tsx src/lib/scheme-product-quantity-billing.test.ts
 *
 * Business case: VAJEER committed 200 KG @ ₹100 / ₹118; ADAM committed 100 KG @ ₹200 / ₹236.
 */
import assert from "node:assert/strict";
import {
  productAmounts, finalBillRemainder, resolveSoBillQuantities, validateSoAllocation,
  validateAdminQuantity, billTotals, combinedTotals, computeProductQuantityBills,
} from "./scheme-product-quantity-billing";
import { combinedPresetValueErrors } from "./scheme-bills";
import { effectiveProductQuantityTarget } from "./scheme-plan-quantity";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const vajeer = { rateWithoutGST: 100, rateWithGST: 118 };
const adam = { rateWithoutGST: 200, rateWithGST: 236 };

/* ---------- effective proceeding target ---------- */
test("Fixed: one scheme keeps the per-scheme target", () => assert.equal(effectiveProductQuantityTarget(100, 1), 100));
test("Fixed: three schemes scale 100 to 300", () => assert.equal(effectiveProductQuantityTarget(100, 3), 300));
test("Fixed: multiple products scale independently", () => assert.deepEqual([100, 200].map((q) => effectiveProductQuantityTarget(q, 3)), [300, 600]));
test("Options: only the selected option target is scaled", () => {
  const option1 = 100, selectedOption2 = 200;
  assert.equal(effectiveProductQuantityTarget(selectedOption2, 3), 600);
  assert.notEqual(effectiveProductQuantityTarget(option1, 3), 600);
});
test("4 to 2 split uses the proceeding two units", () => assert.equal(effectiveProductQuantityTarget(100, 2), 200));
test("three-decimal per-scheme quantities scale and reconcile without paise rounding", () => {
  const target = effectiveProductQuantityTarget(0.125, 3);
  assert.equal(target, 0.375);
  assert.deepEqual(resolveSoBillQuantities(target, [0.1, 0.1], 3), [0.1, 0.1, 0.175]);
  assert.equal(validateSoAllocation(target, [0.1, 0.1, 0.175]), null);
});
test("booking coverage does not alter the proceeding target", () => {
  const proceedingUnits = 3, bookingCoverageUnits = 2;
  void bookingCoverageUnits;
  assert.equal(effectiveProductQuantityTarget(100, proceedingUnits), 300);
});

/* ---------- rate calculation (9,10) ---------- */
test("W/O + With GST: 80 × 100/118", () => assert.deepEqual(productAmounts(80, vajeer), { withoutGST: 8000, withGST: 9440 }));
test("W/O + With GST: 75 × 100/118", () => assert.deepEqual(productAmounts(75, vajeer), { withoutGST: 7500, withGST: 8850 }));
test("Fixed Product Quantity: 300 × 100/118", () => assert.deepEqual(productAmounts(300, vajeer), { withoutGST: 30000, withGST: 35400 }));
test("decimal quantity keeps paise precision", () => assert.deepEqual(productAmounts(12.345, vajeer), { withoutGST: 1234.5, withGST: 1456.71 }));
test("three proceeding units affect the target once, not an already-effective bill quantity", () => {
  const effectiveQty = effectiveProductQuantityTarget(100, 3);
  assert.deepEqual(productAmounts(effectiveQty, vajeer), { withoutGST: 30000, withGST: 35400 });
});
test("4 to 2 split affects the target once, not an already-effective bill quantity", () => {
  const effectiveQty = effectiveProductQuantityTarget(100, 2);
  assert.deepEqual(productAmounts(effectiveQty, vajeer), { withoutGST: 20000, withGST: 23600 });
});
test("negative qty → 0 amounts", () => assert.deepEqual(productAmounts(-5, vajeer), { withoutGST: 0, withGST: 0 }));

/* ---------- one bill (1,3) ---------- */
test("single bill takes the whole committed qty", () => assert.deepEqual(resolveSoBillQuantities(200, [], 1), [200]));

/* ---------- multiple bills + last-bill remainder (2,5) ---------- */
test("2 bills: enter 80 → final 120", () => assert.deepEqual(resolveSoBillQuantities(200, [80], 2), [80, 120]));
test("3 bills: enter 75,50 → final 75", () => assert.deepEqual(resolveSoBillQuantities(200, [75, 50], 3), [75, 50, 75]));
test("finalBillRemainder(200,[90,50]) = 60", () => assert.equal(finalBillRemainder(200, [90, 50]), 60));

/* ---------- changing an earlier bill updates the remainder (6,8) ---------- */
test("change bill 1 80→90: final becomes 110", () => assert.deepEqual(resolveSoBillQuantities(200, [90], 2), [90, 110]));

/* ---------- validation (7,8) ---------- */
test("total > committed rejected", () => assert.match(validateSoAllocation(200, [150, 100])!, /exceed/i));
test("negative bill rejected", () => assert.equal(validateSoAllocation(200, [-10, 210]), "Bill quantity cannot be negative."));
test("must total committed", () => assert.match(validateSoAllocation(200, [80, 100])!, /must total/i));
test("valid allocation → null", () => assert.equal(validateSoAllocation(200, [80, 120]), null));
test("scaled SO target rejects 250 when three schemes require 300", () => assert.match(validateSoAllocation(effectiveProductQuantityTarget(100, 3), [250])!, /must total/i));
test("scaled SO target accepts exactly 300", () => assert.equal(validateSoAllocation(effectiveProductQuantityTarget(100, 3), [300]), null));

/* ---------- admin actual quantity (9,10,12) ---------- */
test("admin negative rejected", () => assert.equal(validateAdminQuantity(-1), "Actual quantity cannot be negative."));
test("admin may exceed committed (no cap)", () => assert.equal(validateAdminQuantity(250), null));

/* ---------- bill + combined totals, multiple products (4,11,13,14) ---------- */
test("bill total across 2 products", () => {
  // VAJEER 80 + ADAM 40 → W/O 8000+8000=16000 ; With 9440+9440=18880
  const t = billTotals([{ rate: vajeer, quantity: 80 }, { rate: adam, quantity: 40 }]);
  assert.deepEqual(t, { withoutGST: 16000, withGST: 18880 });
});
test("combined totals reconcile to committed × rate (SO 80/120 + 40/60)", () => {
  const bill1 = [{ rate: vajeer, quantity: 80 }, { rate: adam, quantity: 40 }];
  const bill2 = [{ rate: vajeer, quantity: 120 }, { rate: adam, quantity: 60 }];
  const c = combinedTotals([bill1, bill2]);
  // VAJEER 200×100=20000 + ADAM 100×200=20000 = 40000 ; With: 200×118 + 100×236 = 23600+23600 = 47200
  assert.deepEqual(c, { withoutGST: 40000, withGST: 47200 });
});

/* ---------- installment base = ADMIN-VERIFIED, not SO-proposed (11,15,16) ---------- */
test("verified total uses ADMIN actual qty, not SO qty", () => {
  // Committed 200; SO proposed 80/120 (=200) → With GST 23,600.
  const soCombined = combinedTotals([[{ rate: vajeer, quantity: 80 }], [{ rate: vajeer, quantity: 120 }]]);
  assert.equal(soCombined.withGST, 23600);
  // Admin actual 90/130 (=220) → the installment base is the VERIFIED 25,960, NOT the SO 23,600.
  const adminBill1 = billTotals([{ rate: vajeer, quantity: 90 }]);
  const adminBill2 = billTotals([{ rate: vajeer, quantity: 130 }]);
  assert.equal(adminBill1.withGST, 10620);
  assert.equal(adminBill2.withGST, 15340);
  const verified = combinedTotals([[{ rate: vajeer, quantity: 90 }], [{ rate: vajeer, quantity: 130 }]]);
  assert.equal(verified.withGST, 25960);
  assert.notEqual(verified.withGST, soCombined.withGST);
});

/* ---------- historical rate stability (13) ---------- */
test("amounts use the rate passed in (snapshot), not any external/current rate", () => {
  const snapshot = { rateWithoutGST: 100, rateWithGST: 118 };
  const current = { rateWithoutGST: 999, rateWithGST: 999 };
  void current; // a later Scheme Master edit must not affect a historical calc — the lib only sees `snapshot`.
  assert.deepEqual(productAmounts(10, snapshot), { withoutGST: 1000, withGST: 1180 });
});

/* ---------- computeProductQuantityBills: server sourcing (SO + Admin) ---------- */
const committed = [
  { productId: "vajeer", committedQty: 200, rateWithoutGST: 100, rateWithGST: 118 },
  { productId: "adam", committedQty: 100, rateWithoutGST: 200, rateWithGST: 236 },
];
test("SO sourcing: 2 bills, 2 products → per-bill amounts + combined; valid", () => {
  const r = computeProductQuantityBills([
    { partNumber: 1, products: [{ productId: "vajeer", qty: 80 }, { productId: "adam", qty: 40 }] },
    { partNumber: 2, products: [{ productId: "vajeer", qty: 120 }, { productId: "adam", qty: 60 }] },
  ], committed, "so");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.billAmounts.get(1), { withoutGST: 16000, withGST: 18880 });
  assert.deepEqual(r.billAmounts.get(2), { withoutGST: 24000, withGST: 28320 });
  assert.deepEqual(r.total, { withoutGST: 40000, withGST: 47200 });
});
test("SO sourcing: under-allocated product → error", () => {
  const r = computeProductQuantityBills([{ partNumber: 1, products: [{ productId: "vajeer", qty: 150 }, { productId: "adam", qty: 100 }] }], committed, "so");
  assert.ok(r.errors.some((e) => /must total its committed/.test(e)));
});
test("SO sourcing: over-allocated product → error", () => {
  const r = computeProductQuantityBills([{ partNumber: 1, products: [{ productId: "vajeer", qty: 250 }, { productId: "adam", qty: 100 }] }], committed, "so");
  assert.ok(r.errors.some((e) => /exceed its committed/.test(e)));
});
test("Admin sourcing: actual qty may differ (90/130 of 200) → verified amounts, no committed error", () => {
  const r = computeProductQuantityBills([
    { partNumber: 1, products: [{ productId: "vajeer", qty: 90 }] },
    { partNumber: 2, products: [{ productId: "vajeer", qty: 130 }] },
  ], [{ productId: "vajeer", committedQty: 200, rateWithoutGST: 100, rateWithGST: 118 }], "admin");
  assert.deepEqual(r.errors, []);
  assert.equal(r.billAmounts.get(1)!.withGST, 10620);
  assert.equal(r.billAmounts.get(2)!.withGST, 15340);
  assert.equal(r.total.withGST, 25960); // installment base = verified 25,960 (not SO's 23,600)
});
test("sourcing: unknown product → error", () => {
  const r = computeProductQuantityBills([{ partNumber: 1, products: [{ productId: "ghost", qty: 10 }] }], committed, "admin");
  assert.ok(r.errors.some((e) => /Unknown product/.test(e)));
});

/* ---------- Options + Value Based: free quantities, monetary target ---------- */
const valueProducts = [
  { productId: "adhbut", committedQty: null, rateWithoutGST: 212, rateWithGST: 250 },
  { productId: "abc", committedQty: null, rateWithoutGST: 300, rateWithGST: 354 },
];
test("Value Based quantity derives amount without requiring a committed product quantity", () => {
  const result = computeProductQuantityBills([{ partNumber: 1, products: [{ productId: "adhbut", qty: 200 }] }], valueProducts, "so");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.billAmounts.get(1), { withoutGST: 42400, withGST: 50000 });
});
test("Value Based multiple products use their own rates", () => {
  const result = computeProductQuantityBills([{ partNumber: 1, products: [{ productId: "adhbut", qty: 200 }, { productId: "abc", qty: 100 }] }], valueProducts, "so");
  assert.deepEqual(result.total, { withoutGST: 72400, withGST: 85400 });
});
test("Value Based multiple bills sum to one combined calculated value", () => {
  const result = computeProductQuantityBills([
    { partNumber: 1, products: [{ productId: "adhbut", qty: 200 }, { productId: "abc", qty: 100 }] },
    { partNumber: 2, products: [{ productId: "adhbut", qty: 50 }, { productId: "abc", qty: 60 }] },
  ], valueProducts, "so");
  assert.deepEqual(result.billAmounts.get(1), { withoutGST: 72400, withGST: 85400 });
  assert.deepEqual(result.billAmounts.get(2), { withoutGST: 28600, withGST: 33740 });
  assert.deepEqual(result.total, { withoutGST: 101000, withGST: 119140 });
});
for (const [actual, expected] of [[98000, false], [100000, true], [105000, true]] as const) test(`Value Based target ₹1,00,000 with ₹${actual} ${expected ? "passes" : "fails"}`, () => {
  const errors = combinedPresetValueErrors({ amountWithoutGST: actual, amountWithGST: actual * 1.18 }, { amountWithoutGST: 100000, amountWithGST: 118000 });
  assert.equal(errors.length === 0, expected);
});
test("Value Based Admin actual quantity is authoritative", () => {
  const so = computeProductQuantityBills([{ partNumber: 1, products: [{ productId: "adhbut", qty: 400 }] }], valueProducts, "so");
  const admin = computeProductQuantityBills([{ partNumber: 1, products: [{ productId: "adhbut", qty: 500 }] }], valueProducts, "admin");
  assert.equal(so.total.withoutGST, 84800);
  assert.equal(admin.total.withoutGST, 106000);
});

console.log(`\n${passed} product-quantity billing tests passed`);
