/**
 * Focused unit tests for the pure Scheme Achievement engine (`scheme-achievement.ts`).
 * Runnable without a database or Prisma: `npx tsx src/lib/scheme-achievement.test.ts`.
 *
 * The DB-level rules (only ACTIVE scopes, only ENROLLED dealers) are exercised here through the engine's
 * contract: the server loaders pass only ACTIVE-scope facts and only enrolled dealer ids, and the engine
 * counts exactly what it is given — these tests assert that counting/gating behaviour directly.
 */
import assert from "node:assert/strict";
import {
  installmentPaidTotal,
  dealerProductAchievement,
  schemeProductAchievement,
  dealerValueAchievement,
  schemeValueAchievement,
  combineDealerProduct,
  uploadImpact,
  type SchemeRequirement,
  type SchemeSaleFact,
} from "./scheme-achievement";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const sums = (pairs: [string, { qty: number; value: number }][]) => new Map(pairs);

/* ------------------------------- installments ------------------------------- */

test("installment: fully paid counts", () => {
  const r = installmentPaidTotal([{ plannedAmount: 50000, receivedAmount: 50000 }]);
  assert.deepEqual(r, { paid: 1, total: 1 });
});
test("installment: over-paid still counts as paid", () => {
  const r = installmentPaidTotal([{ plannedAmount: 50000, receivedAmount: 50001 }]);
  assert.deepEqual(r, { paid: 1, total: 1 });
});
test("installment: partial payment does NOT count", () => {
  const r = installmentPaidTotal([{ plannedAmount: 50000, receivedAmount: 25000 }]);
  assert.deepEqual(r, { paid: 0, total: 1 });
});
test("installment: unpaid (null) does NOT count", () => {
  const r = installmentPaidTotal([{ plannedAmount: 50000, receivedAmount: null }]);
  assert.deepEqual(r, { paid: 0, total: 1 });
});
test("installment: mixed 2/5", () => {
  const r = installmentPaidTotal([
    { plannedAmount: 10000, receivedAmount: 10000 },
    { plannedAmount: 10000, receivedAmount: 10000 },
    { plannedAmount: 10000, receivedAmount: 9999.99 }, // one paise short → not paid
    { plannedAmount: 10000, receivedAmount: null },
    { plannedAmount: 10000, receivedAmount: 0 },
  ]);
  assert.deepEqual(r, { paid: 2, total: 5 });
});

/* ------------------------------- product based ------------------------------- */

const productReq = (products: { productId: string; requiredQty: number }[]): SchemeRequirement => ({
  type: "PRODUCT_BASED", valueMode: null, combinedRequiredValue: null,
  products: products.map((p) => ({ productId: p.productId, requiredQty: p.requiredQty, requiredValue: null })),
});

test("product based: single product, partial", () => {
  const req = productReq([{ productId: "ADAM", requiredQty: 1000 }]);
  const a = dealerProductAchievement(req, sums([["ADAM", { qty: 750, value: 0 }]]));
  assert.equal(a.requiredQty, 1000);
  assert.equal(a.achievedQty, 750);
  assert.equal(a.remainingQty, 250);
  assert.equal(a.productsCompleted, 0);
  assert.equal(a.productsTotal, 1);
});
test("product based: excess achievement → remaining 0, completed", () => {
  const req = productReq([{ productId: "ODIN", requiredQty: 1000 }]);
  const a = dealerProductAchievement(req, sums([["ODIN", { qty: 1050, value: 0 }]]));
  assert.equal(a.remainingQty, 0); // never negative
  assert.equal(a.productsCompleted, 1);
  assert.equal(a.items[0].completed, true);
});
test("product based: multiple products, per-item floored remaining (no offset)", () => {
  const req = productReq([{ productId: "ADAM", requiredQty: 1000 }, { productId: "ODIN", requiredQty: 1000 }]);
  const a = dealerProductAchievement(req, sums([["ADAM", { qty: 1050, value: 0 }], ["ODIN", { qty: 750, value: 0 }]]));
  assert.equal(a.remainingQty, 250); // ADAM over (0) + ODIN short (250); over-achievement does NOT offset
  assert.equal(a.productsCompleted, 1);
  assert.equal(a.productsTotal, 2);
});
test("product based: scheme aggregate across multiple enrolled dealers + Products Completed", () => {
  const req = productReq([{ productId: "ADAM", requiredQty: 1000 }, { productId: "ODIN", requiredQty: 1000 }]);
  const sales: SchemeSaleFact[] = [
    { dealerId: "D1", productId: "ADAM", qty: 1000, value: 0 },
    { dealerId: "D1", productId: "ODIN", qty: 700, value: 0 },
    { dealerId: "D2", productId: "ADAM", qty: 1000, value: 0 },
    { dealerId: "D2", productId: "ODIN", qty: 1300, value: 0 }, // ADAM agg 2000/2000 done; ODIN 2000/2000 done
  ];
  const s = schemeProductAchievement(req, sales, ["D1", "D2"]);
  assert.equal(s.dealerCount, 2);
  assert.equal(s.requiredQty, 4000); // 2 products × 1000 × 2 dealers
  assert.equal(s.achievedQty, 4000);
  assert.equal(s.productsCompleted, 2); // both products complete in aggregate
  assert.equal(s.perDealer.length, 2);
});
test("product based: enrolled dealer with NO sales still counts toward required", () => {
  const req = productReq([{ productId: "ADAM", requiredQty: 1000 }]);
  const s = schemeProductAchievement(req, [{ dealerId: "D1", productId: "ADAM", qty: 1000, value: 0 }], ["D1", "D2"]);
  assert.equal(s.requiredQty, 2000); // both dealers
  assert.equal(s.achievedQty, 1000);
  assert.equal(s.remainingQty, 1000); // D2 contributes 1000 remaining
});
test("product based: non-enrolled dealer's sale is EXCLUDED", () => {
  const req = productReq([{ productId: "ADAM", requiredQty: 1000 }]);
  const sales: SchemeSaleFact[] = [
    { dealerId: "D1", productId: "ADAM", qty: 400, value: 0 },
    { dealerId: "GHOST", productId: "ADAM", qty: 999, value: 0 }, // not in enrolled set
  ];
  const s = schemeProductAchievement(req, sales, ["D1"]);
  assert.equal(s.achievedQty, 400); // GHOST excluded
  assert.equal(s.dealerCount, 1);
});
test("product based: same sale contributes independently to two schemes", () => {
  const reqA = productReq([{ productId: "ADAM", requiredQty: 1000 }]);
  const reqB = productReq([{ productId: "ADAM", requiredQty: 1000 }]);
  const sale: SchemeSaleFact[] = [{ dealerId: "D1", productId: "ADAM", qty: 1200, value: 0 }];
  // Callers pass each scheme its own copy of the sale — engine counts each fully & independently.
  const a = schemeProductAchievement(reqA, sale, ["D1"]);
  const b = schemeProductAchievement(reqB, sale, ["D1"]);
  assert.equal(a.achievedQty, 1200);
  assert.equal(b.achievedQty, 1200);
  assert.equal(a.productsCompleted, 1);
  assert.equal(b.productsCompleted, 1);
});
test("product based: decimal quantities preserved", () => {
  const req = productReq([{ productId: "ADAM", requiredQty: 1000.5 }]);
  const a = dealerProductAchievement(req, sums([["ADAM", { qty: 250.125, value: 0 }]]));
  assert.equal(a.requiredQty, 1000.5);
  assert.equal(a.achievedQty, 250.125);
  assert.equal(a.remainingQty, 750.375);
});

/* -------------------------------- value based -------------------------------- */

test("value based INDIVIDUAL: per-product targets", () => {
  const req: SchemeRequirement = {
    type: "VALUE_BASED", valueMode: "INDIVIDUAL", combinedRequiredValue: null,
    products: [
      { productId: "ADAM", requiredQty: null, requiredValue: 200000 },
      { productId: "ODIN", requiredQty: null, requiredValue: 150000 },
    ],
  };
  const a = dealerValueAchievement(req, sums([["ADAM", { qty: 10, value: 200000 }], ["ODIN", { qty: 5, value: 90000 }]]));
  assert.equal(a.mode, "INDIVIDUAL");
  assert.equal(a.requiredValue, 350000);
  assert.equal(a.achievedValue, 290000);
  assert.equal(a.remainingValue, 60000); // ADAM met (0) + ODIN short (60000)
  assert.equal(a.itemsCompleted, 1);
  assert.equal(a.itemsTotal, 2);
});
test("value based COMBINED: one target across participating products, no double count", () => {
  const req: SchemeRequirement = {
    type: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 500000,
    products: [
      { productId: "ADAM", requiredQty: null, requiredValue: null },
      { productId: "ODIN", requiredQty: null, requiredValue: null },
      { productId: "ROTOMAXX", requiredQty: null, requiredValue: null },
    ],
  };
  const a = dealerValueAchievement(req, sums([["ADAM", { qty: 1, value: 200000 }], ["ODIN", { qty: 1, value: 150000 }], ["ROTOMAXX", { qty: 1, value: 100000 }]]));
  assert.equal(a.requiredValue, 500000);
  assert.equal(a.achievedValue, 450000); // sum of participating products, each once
  assert.equal(a.remainingValue, 50000);
  assert.equal(a.completed, false);
  assert.equal(a.itemsTotal, 1);
});
test("value based COMBINED: met → remaining 0, completed", () => {
  const req: SchemeRequirement = {
    type: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 500000,
    products: [{ productId: "ADAM", requiredQty: null, requiredValue: null }, { productId: "ODIN", requiredQty: null, requiredValue: null }],
  };
  const a = dealerValueAchievement(req, sums([["ADAM", { qty: 1, value: 300000 }], ["ODIN", { qty: 1, value: 250000 }]]));
  assert.equal(a.achievedValue, 550000);
  assert.equal(a.remainingValue, 0);
  assert.equal(a.completed, true);
});
test("value based: scheme aggregate across dealers", () => {
  const req: SchemeRequirement = {
    type: "VALUE_BASED", valueMode: "INDIVIDUAL", combinedRequiredValue: null,
    products: [{ productId: "ADAM", requiredQty: null, requiredValue: 100000 }],
  };
  const s = schemeValueAchievement(req, [
    { dealerId: "D1", productId: "ADAM", qty: 5, value: 100000 },
    { dealerId: "D2", productId: "ADAM", qty: 3, value: 60000 },
  ], ["D1", "D2"]);
  assert.equal(s.requiredValue, 200000);
  assert.equal(s.achievedValue, 160000);
  assert.equal(s.remainingValue, 40000);
  assert.equal(s.achievedQty, 8); // supporting qty retained
});
test("value based: decimal values preserved", () => {
  const req: SchemeRequirement = {
    type: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 1000.55,
    products: [{ productId: "ADAM", requiredQty: null, requiredValue: null }],
  };
  const a = dealerValueAchievement(req, sums([["ADAM", { qty: 1.5, value: 250.25 }]]));
  assert.equal(a.requiredValue, 1000.55);
  assert.equal(a.achievedValue, 250.25);
  assert.equal(a.remainingValue, 750.3);
});

/* --------------------------------- NONE / cross-scheme / impact --------------------------------- */

test("NONE requirement: no products → empty achievement", () => {
  const req: SchemeRequirement = { type: "NONE", valueMode: null, combinedRequiredValue: null, products: [] };
  const a = dealerProductAchievement(req, new Map());
  assert.equal(a.productsTotal, 0);
  assert.equal(a.requiredQty, 0);
  assert.equal(a.progress, null);
});
test("cross-scheme dealer combine (Products Completed sums across schemes)", () => {
  const reqA = productReq([{ productId: "ADAM", requiredQty: 1000 }, { productId: "ODIN", requiredQty: 1000 }]);
  const reqB = productReq([{ productId: "ROTOMAXX", requiredQty: 500 }]);
  const a = dealerProductAchievement(reqA, sums([["ADAM", { qty: 1000, value: 0 }], ["ODIN", { qty: 1000, value: 0 }]]));
  const b = dealerProductAchievement(reqB, sums([["ROTOMAXX", { qty: 320, value: 0 }]]));
  const c = combineDealerProduct([a, b]);
  assert.equal(c.productsCompleted, 2); // ADAM + ODIN complete; ROTOMAXX not
  assert.equal(c.productsTotal, 3);
  assert.equal(c.requiredQty, 2500);
  assert.equal(c.achievedQty, 2320);
  assert.equal(c.remainingQty, 180);
});
test("upload impact: previous + new, completion transition", () => {
  const req = productReq([{ productId: "ADAM", requiredQty: 1000 }]);
  const previous = new Map([["D1|ADAM", { qty: 400, value: 0 }]]);
  const incoming = new Map([["D1|ADAM", { qty: 700, value: 0 }]]);
  const rows = uploadImpact(req, previous, incoming, ["D1"]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.previouslyAchievedQty, 400);
  assert.equal(r.newAchievedQty, 700);
  assert.equal(r.totalAchievedQty, 1100);
  assert.equal(r.remainingQty, 0);
  assert.equal(r.completedBefore, false);
  assert.equal(r.completedAfter, true);
});
test("upload impact: non-enrolled and non-required rows dropped", () => {
  const req = productReq([{ productId: "ADAM", requiredQty: 1000 }]);
  const incoming = new Map([
    ["D1|ADAM", { qty: 500, value: 0 }],
    ["GHOST|ADAM", { qty: 999, value: 0 }], // dealer not enrolled
    ["D1|XYZ", { qty: 999, value: 0 }], // product not required
  ]);
  const rows = uploadImpact(req, new Map(), incoming, ["D1"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dealerId, "D1");
  assert.equal(rows[0].productId, "ADAM");
});

console.log(`\nAll ${passed} scheme-achievement tests passed.`);
