import assert from "node:assert/strict";
import { distinctPlanTotals, quantityPortionAmount, quantitySplitDecision } from "./scheme-plan-quantity";

assert.deepEqual(quantitySplitDecision(4, 4, undefined), {
  originalQuantity: 4, proceedingQuantity: 4, remainingQuantity: 0, disposition: null, split: false,
});
assert.deepEqual(quantitySplitDecision(4, 2, "FUTURE_DRAFT"), {
  originalQuantity: 4, proceedingQuantity: 2, remainingQuantity: 2, disposition: "FUTURE_DRAFT", split: true,
});
assert.deepEqual(quantitySplitDecision(4, 2, "CANCELLED"), {
  originalQuantity: 4, proceedingQuantity: 2, remainingQuantity: 2, disposition: "CANCELLED", split: true,
});
assert.throws(() => quantitySplitDecision(4, 5, "FUTURE_DRAFT"), /cannot exceed.*4/);
assert.throws(() => quantitySplitDecision(4, 2, undefined), /Choose whether.*remaining 2/);
assert.equal(quantityPortionAmount(100000, 4, 2), 50000);
assert.deepEqual(distinctPlanTotals([{ dealerId: "dealer", numberOfSchemes: 2 }, { dealerId: "dealer", numberOfSchemes: 2 }]), { dealers: 1, schemes: 4 });
assert.deepEqual(distinctPlanTotals([{ dealerId: "dealer", numberOfSchemes: 2 }]), { dealers: 1, schemes: 2 });
const statusSegments = [
  { dealerId: "dealer", numberOfSchemes: 2, planStatus: "APPROVED" },
  { dealerId: "dealer", numberOfSchemes: 2, planStatus: "PENDING_RM" },
];
assert.deepEqual(distinctPlanTotals(statusSegments), { dealers: 1, schemes: 4 });
assert.deepEqual(distinctPlanTotals(statusSegments.filter((row) => row.planStatus === "PENDING_RM")), { dealers: 1, schemes: 2 });

console.log("10 quantity-split contracts passed");
