/**
 * Phase 6 — Follow-up achievement transformation/aggregation tests.
 *
 * The Scheme/Dealer Follow-up Product & Value views are thin presenters over the Phase 4 AUTHORITATIVE
 * engine (`scheme-achievement.ts`): the server loads enrolled dealers + ACTIVE-scope sales and delegates
 * every Required/Achieved/Remaining/Completed/Progress number to these pure functions. These tests exercise
 * exactly the engine calls the follow-up server composes, covering the 15 scenarios in the Phase 6 spec.
 * Runnable without a database: `npx tsx src/lib/scheme-follow-up.test.ts`.
 */
import assert from "node:assert/strict";
import {
  installmentPaidTotal,
  schemeProductAchievement,
  schemeValueAchievement,
  combineDealerProduct,
  combineDealerValue,
  type SchemeRequirement,
  type SchemeSaleFact,
} from "./scheme-achievement";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const approx = (a: number | null, b: number, msg?: string) => assert.ok(a != null && Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ~${b}, got ${a}`);

const productReq = (products: { productId: string; requiredQty: number }[]): SchemeRequirement => ({
  type: "PRODUCT_BASED", valueMode: null, combinedRequiredValue: null,
  products: products.map((p) => ({ productId: p.productId, requiredQty: p.requiredQty, requiredValue: null })),
});
const valueIndividualReq = (products: { productId: string; requiredValue: number }[]): SchemeRequirement => ({
  type: "VALUE_BASED", valueMode: "INDIVIDUAL", combinedRequiredValue: null,
  products: products.map((p) => ({ productId: p.productId, requiredQty: null, requiredValue: p.requiredValue })),
});
const valueCombinedReq = (productIds: string[], combined: number): SchemeRequirement => ({
  type: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: combined,
  products: productIds.map((productId) => ({ productId, requiredQty: null, requiredValue: null })),
});
const q = (dealerId: string, productId: string, qty: number): SchemeSaleFact => ({ dealerId, productId, qty, value: 0 });
const v = (dealerId: string, productId: string, value: number): SchemeSaleFact => ({ dealerId, productId, qty: 0, value });

/* ------------------------- 1 & 2: Scheme Product Based summary + expanded dealer ------------------------- */

const REQ_AO = productReq([{ productId: "ADAM", requiredQty: 1000 }, { productId: "ODIN", requiredQty: 1000 }]);
const SALES_AB: SchemeSaleFact[] = [q("A", "ADAM", 750), q("A", "ODIN", 1000), q("B", "ADAM", 1000), q("B", "ODIN", 500)];

test("1. Scheme Product Based summary aggregates required/achieved/remaining across enrolled dealers", () => {
  const s = schemeProductAchievement(REQ_AO, SALES_AB, ["A", "B"]);
  assert.equal(s.dealerCount, 2);
  assert.equal(s.productCount, 2);
  approx(s.requiredQty, 4000, "requiredQty");   // (1000+1000) per dealer × 2 dealers
  approx(s.achievedQty, 3250, "achievedQty");   // 1750 + 1500
  approx(s.remainingQty, 750, "remainingQty");  // per-item floored: A ODIN 0 + A ADAM 250 + B ADAM 0 + B ODIN 500
});

test("2. Scheme Product Based expanded dealer data is per dealer/product", () => {
  const s = schemeProductAchievement(REQ_AO, SALES_AB, ["A", "B"]);
  const a = s.perDealer.find((d) => d.dealerId === "A")!.achievement;
  assert.equal(a.productsCompleted, 1); // ODIN met (1000/1000), ADAM not (750/1000)
  assert.equal(a.productsTotal, 2);
  const adam = a.items.find((i) => i.productId === "ADAM")!;
  const odin = a.items.find((i) => i.productId === "ODIN")!;
  assert.deepEqual([adam.achievedQty, adam.remainingQty, adam.completed], [750, 250, false]);
  assert.deepEqual([odin.achievedQty, odin.remainingQty, odin.completed], [1000, 0, true]);
});

test("2b. Product excess does not offset another product's shortfall (Products Completed 1/2)", () => {
  const s = schemeProductAchievement(REQ_AO, [q("A", "ADAM", 2000), q("A", "ODIN", 500)], ["A"]);
  assert.equal(s.productsCompleted, 1); // ADAM complete; ODIN short — NOT 2/2 despite total 2500 > 2000
  assert.equal(s.productsTotal, 2);
});

/* ------------------------- 3 & 15: Dealer Product aggregation (underlying facts) ------------------------- */

test("3. Dealer Product Based aggregation sums underlying required/achieved/completed across schemes", () => {
  const scheme1 = schemeProductAchievement(productReq([{ productId: "ADAM", requiredQty: 1000 }]), [q("A", "ADAM", 1000)], ["A"]);
  const scheme2 = schemeProductAchievement(productReq([{ productId: "ODIN", requiredQty: 1000 }]), [q("A", "ODIN", 750)], ["A"]);
  const partA = [scheme1, scheme2].map((s) => s.perDealer.find((d) => d.dealerId === "A")!.achievement);
  const combined = combineDealerProduct(partA);
  approx(combined.requiredQty, 2000);
  approx(combined.achievedQty, 1750);
  approx(combined.remainingQty, 250);
  assert.equal(combined.productsCompleted, 1); // ADAM complete, ODIN not
  assert.equal(combined.productsTotal, 2);
});

test("15. Dealer aggregate progress uses underlying totals, NOT an average of scheme percentages", () => {
  // Scheme1: 100/100 = 100%. Scheme2: 500/1000 = 50%. Average would be 75%; true ratio is 600/1100 ≈ 54.5%.
  const s1 = schemeProductAchievement(productReq([{ productId: "P1", requiredQty: 100 }]), [q("A", "P1", 100)], ["A"]);
  const s2 = schemeProductAchievement(productReq([{ productId: "P2", requiredQty: 1000 }]), [q("A", "P2", 500)], ["A"]);
  const combined = combineDealerProduct([s1, s2].map((s) => s.perDealer[0].achievement));
  approx(combined.progress, 600 / 1100);
  assert.notEqual(Math.round((combined.progress ?? 0) * 1000) / 1000, 0.75);
});

/* ------------------------- 4, 5, 6: Value Based ------------------------- */

test("4. Scheme Value Based INDIVIDUAL aggregates per-product value targets", () => {
  const req = valueIndividualReq([{ productId: "ADAM", requiredValue: 200000 }, { productId: "ODIN", requiredValue: 150000 }]);
  const sales = [v("A", "ADAM", 200000), v("A", "ODIN", 100000), v("B", "ADAM", 150000), v("B", "ODIN", 150000)];
  const s = schemeValueAchievement(req, sales, ["A", "B"]);
  assert.equal(s.mode, "INDIVIDUAL");
  approx(s.requiredValue, 700000);   // 350000 per dealer × 2
  approx(s.achievedValue, 600000);   // 300000 + 300000
  approx(s.remainingValue, 100000);  // A: ODIN 50000; B: 0 → 50000? per-item: A ADAM 0, A ODIN 50000, B ADAM 0, B ODIN 0 = 50000
});

test("5. Scheme Value Based COMBINED uses one target, no double counting", () => {
  const req = valueCombinedReq(["ADAM", "ODIN"], 500000);
  const sales = [v("A", "ADAM", 200000), v("A", "ODIN", 150000), v("B", "ADAM", 100000), v("B", "ODIN", 50000)];
  const s = schemeValueAchievement(req, sales, ["A", "B"]);
  assert.equal(s.mode, "COMBINED");
  approx(s.requiredValue, 1000000); // 500000 per dealer × 2
  approx(s.achievedValue, 500000);  // A 350000 + B 150000, each product counted once
  approx(s.remainingValue, 500000);
  const a = s.perDealer.find((d) => d.dealerId === "A")!.achievement;
  approx(a.achievedValue, 350000); // sum across participating products, not doubled
});

test("6. Dealer Value Based aggregation sums underlying values across schemes", () => {
  const s1 = schemeValueAchievement(valueIndividualReq([{ productId: "ADAM", requiredValue: 200000 }]), [v("A", "ADAM", 200000)], ["A"]);
  const s2 = schemeValueAchievement(valueCombinedReq(["ODIN", "THOR"], 300000), [v("A", "ODIN", 100000), v("A", "THOR", 50000)], ["A"]);
  const combined = combineDealerValue([s1, s2].map((s) => s.perDealer[0].achievement));
  approx(combined.requiredValue, 500000); // 200000 + 300000
  approx(combined.achievedValue, 350000); // 200000 + 150000
  approx(combined.remainingValue, 150000);
});

/* ------------------------- 7 & 8: Installment full-payment rule ------------------------- */

test("7. Partial installment does NOT count as paid", () => {
  assert.deepEqual(installmentPaidTotal([{ plannedAmount: 50000, receivedAmount: 25000 }]), { paid: 0, total: 1 });
});
test("8. Fully paid (or over-paid) installment counts as paid", () => {
  assert.deepEqual(installmentPaidTotal([{ plannedAmount: 50000, receivedAmount: 50000 }, { plannedAmount: 50000, receivedAmount: 60000 }]), { paid: 2, total: 2 });
});

/* ------------------------- 9, 10, 11, 12, 13, 14: population & edge cases ------------------------- */

test("9. Superseded SchemeSale data is excluded (loader passes ACTIVE only; inclusion would corrupt)", () => {
  const active = [q("A", "ADAM", 1000)];
  const withSuperseded = [...active, q("A", "ADAM", 500)]; // a superseded scope's row, if wrongly included
  approx(schemeProductAchievement(REQ_AO, active, ["A"]).achievedQty, 1000);
  approx(schemeProductAchievement(REQ_AO, withSuperseded, ["A"]).achievedQty, 1500); // differs → exclusion matters
});

test("10. Non-enrolled dealer does not contribute", () => {
  const s = schemeProductAchievement(productReq([{ productId: "ADAM", requiredQty: 1000 }]), [q("A", "ADAM", 1000), q("C", "ADAM", 9999)], ["A"]);
  assert.equal(s.dealerCount, 1);
  approx(s.achievedQty, 1000); // C excluded entirely
  assert.ok(!s.perDealer.some((d) => d.dealerId === "C"));
});

test("11. Enrolled dealer with zero sales is retained with achievement 0", () => {
  const s = schemeProductAchievement(productReq([{ productId: "ADAM", requiredQty: 1000 }]), [q("A", "ADAM", 1000)], ["A", "B"]);
  assert.equal(s.dealerCount, 2);
  const b = s.perDealer.find((d) => d.dealerId === "B")!.achievement;
  approx(b.achievedQty, 0);
  approx(b.remainingQty, 1000);
});

test("12. Product scheme with zero sales is retained (required > 0, achieved 0, progress 0)", () => {
  const s = schemeProductAchievement(productReq([{ productId: "ADAM", requiredQty: 1000 }]), [], ["A"]);
  approx(s.requiredQty, 1000);
  approx(s.achievedQty, 0);
  approx(s.progress, 0);
  assert.equal(s.perDealer.length, 1);
});

test("13. NONE-style requirement (no products) is handled safely", () => {
  const none: SchemeRequirement = { type: "NONE", valueMode: null, combinedRequiredValue: null, products: [] };
  const s = schemeProductAchievement(none, [], ["A"]);
  assert.equal(s.productsTotal, 0);
  approx(s.requiredQty, 0);
  assert.equal(s.progress, null); // no requirement → no progress; follow-up also filters NONE out of these views
});

test("14. Same sale contributes independently to multiple schemes", () => {
  const sale = [q("A", "ADAM", 1000)];
  const scheme1 = schemeProductAchievement(productReq([{ productId: "ADAM", requiredQty: 1000 }]), sale, ["A"]);
  const scheme2 = schemeProductAchievement(productReq([{ productId: "ADAM", requiredQty: 1000 }]), sale, ["A"]);
  approx(scheme1.achievedQty, 1000);
  approx(scheme2.achievedQty, 1000); // not split between the two schemes
});

console.log(`\n${passed} passed`);
