/**
 * Focused unit tests for the pure Scheme Requirement validation + normalization (`scheme-requirement.ts`).
 * Runnable without a database or Prisma: `npx tsx src/lib/scheme-requirement.test.ts`.
 *
 * These are the exact rules the Scheme Master server enforces in its Zod superRefine and the client form
 * enforces before enabling Save — one shared source of truth. Every ambiguous/invalid combination must be
 * rejected here regardless of what the UI would have allowed.
 */
import assert from "node:assert/strict";
import { validateSchemeRequirement, normalizeSchemeRequirement, type SchemeRequirementInput } from "./scheme-requirement";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const valid = (i: SchemeRequirementInput) => assert.deepEqual(validateSchemeRequirement(i), [], `expected valid: ${JSON.stringify(i)}`);
const invalid = (i: SchemeRequirementInput) => assert.ok(validateSchemeRequirement(i).length > 0, `expected invalid: ${JSON.stringify(i)}`);

/* -------------------------------- NONE -------------------------------- */

test("1. NONE with nothing else is valid (installment-only)", () => {
  valid({ requirementType: "NONE" });
  valid({ requirementType: "NONE", valueMode: null, combinedRequiredValue: null, products: [] });
});
test("2. NONE with products is invalid", () => {
  invalid({ requirementType: "NONE", products: [{ productId: "p1", requiredQty: 5 }] });
});
test("3. NONE with a value mode is invalid", () => {
  invalid({ requirementType: "NONE", valueMode: "INDIVIDUAL" });
});
test("4. NONE with a combined value is invalid", () => {
  invalid({ requirementType: "NONE", combinedRequiredValue: 1000 });
});

/* ----------------------------- PRODUCT_BASED ----------------------------- */

test("5. PRODUCT_BASED with qty > 0 per product is valid", () => {
  valid({ requirementType: "PRODUCT_BASED", products: [{ productId: "p1", requiredQty: 10 }, { productId: "p2", requiredQty: 2.5 }] });
});
test("6. PRODUCT_BASED with no products is invalid", () => {
  invalid({ requirementType: "PRODUCT_BASED", products: [] });
});
test("7. PRODUCT_BASED with missing/zero/negative qty is invalid", () => {
  invalid({ requirementType: "PRODUCT_BASED", products: [{ productId: "p1", requiredQty: null }] });
  invalid({ requirementType: "PRODUCT_BASED", products: [{ productId: "p1", requiredQty: 0 }] });
  invalid({ requirementType: "PRODUCT_BASED", products: [{ productId: "p1", requiredQty: -3 }] });
});
test("8. PRODUCT_BASED must not carry a required value", () => {
  invalid({ requirementType: "PRODUCT_BASED", products: [{ productId: "p1", requiredQty: 10, requiredValue: 500 }] });
});
test("9. PRODUCT_BASED with a value mode is invalid", () => {
  invalid({ requirementType: "PRODUCT_BASED", valueMode: "INDIVIDUAL", products: [{ productId: "p1", requiredQty: 10 }] });
});
test("10. PRODUCT_BASED with a combined value is invalid", () => {
  invalid({ requirementType: "PRODUCT_BASED", combinedRequiredValue: 1000, products: [{ productId: "p1", requiredQty: 10 }] });
});
test("11. PRODUCT_BASED with duplicate products is invalid", () => {
  invalid({ requirementType: "PRODUCT_BASED", products: [{ productId: "p1", requiredQty: 10 }, { productId: "p1", requiredQty: 5 }] });
});

/* ------------------------- VALUE_BASED / INDIVIDUAL ------------------------- */

test("12. VALUE_BASED requires a value mode", () => {
  invalid({ requirementType: "VALUE_BASED", valueMode: null, products: [{ productId: "p1", requiredValue: 5000 }] });
});
test("13. VALUE_BASED INDIVIDUAL with value > 0 per product is valid", () => {
  valid({ requirementType: "VALUE_BASED", valueMode: "INDIVIDUAL", products: [{ productId: "p1", requiredValue: 5000 }, { productId: "p2", requiredValue: 250.75 }] });
});
test("14. VALUE_BASED INDIVIDUAL with missing/zero value is invalid", () => {
  invalid({ requirementType: "VALUE_BASED", valueMode: "INDIVIDUAL", products: [{ productId: "p1", requiredValue: null }] });
  invalid({ requirementType: "VALUE_BASED", valueMode: "INDIVIDUAL", products: [{ productId: "p1", requiredValue: 0 }] });
});
test("15. VALUE_BASED INDIVIDUAL must not carry a required quantity", () => {
  invalid({ requirementType: "VALUE_BASED", valueMode: "INDIVIDUAL", products: [{ productId: "p1", requiredValue: 5000, requiredQty: 2 }] });
});
test("16. VALUE_BASED INDIVIDUAL with a combined value is invalid", () => {
  invalid({ requirementType: "VALUE_BASED", valueMode: "INDIVIDUAL", combinedRequiredValue: 9000, products: [{ productId: "p1", requiredValue: 5000 }] });
});

/* -------------------------- VALUE_BASED / COMBINED -------------------------- */

test("17. VALUE_BASED COMBINED with combined value > 0 and participating products is valid", () => {
  valid({ requirementType: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 100000, products: [{ productId: "p1" }, { productId: "p2" }] });
});
test("18. VALUE_BASED COMBINED without combined value (or <= 0) is invalid", () => {
  invalid({ requirementType: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: null, products: [{ productId: "p1" }] });
  invalid({ requirementType: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 0, products: [{ productId: "p1" }] });
});
test("19. VALUE_BASED COMBINED with no products is invalid", () => {
  invalid({ requirementType: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 100000, products: [] });
});
test("20. VALUE_BASED COMBINED must not carry per-product qty/value", () => {
  invalid({ requirementType: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 100000, products: [{ productId: "p1", requiredValue: 5000 }] });
  invalid({ requirementType: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 100000, products: [{ productId: "p1", requiredQty: 5 }] });
});
test("21. VALUE_BASED COMBINED with duplicate products is invalid", () => {
  invalid({ requirementType: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 100000, products: [{ productId: "p1" }, { productId: "p1" }] });
});

/* ------------------------------ normalization ------------------------------ */

test("22. normalize NONE strips everything", () => {
  assert.deepEqual(normalizeSchemeRequirement({ requirementType: "NONE", valueMode: "INDIVIDUAL", combinedRequiredValue: 5, products: [{ productId: "p1", requiredQty: 2 }] }), {
    requirementType: "NONE", valueMode: null, combinedRequiredValue: null, products: [],
  });
});
test("23. normalize PRODUCT_BASED keeps qty, nulls value + mode + combined", () => {
  assert.deepEqual(normalizeSchemeRequirement({ requirementType: "PRODUCT_BASED", valueMode: "COMBINED", combinedRequiredValue: 9, products: [{ productId: "p1", requiredQty: 10, requiredValue: 999 }] }), {
    requirementType: "PRODUCT_BASED", valueMode: null, combinedRequiredValue: null, products: [{ productId: "p1", requiredQty: 10, requiredValue: null }],
  });
});
test("24. normalize VALUE_BASED INDIVIDUAL keeps value, nulls qty + combined", () => {
  assert.deepEqual(normalizeSchemeRequirement({ requirementType: "VALUE_BASED", valueMode: "INDIVIDUAL", combinedRequiredValue: 9, products: [{ productId: "p1", requiredQty: 3, requiredValue: 5000 }] }), {
    requirementType: "VALUE_BASED", valueMode: "INDIVIDUAL", combinedRequiredValue: null, products: [{ productId: "p1", requiredQty: null, requiredValue: 5000 }],
  });
});
test("25. normalize VALUE_BASED COMBINED keeps combined, nulls per-product qty/value", () => {
  assert.deepEqual(normalizeSchemeRequirement({ requirementType: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 100000, products: [{ productId: "p1", requiredQty: 3, requiredValue: 5000 }, { productId: "p2" }] }), {
    requirementType: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 100000, products: [{ productId: "p1", requiredQty: null, requiredValue: null }, { productId: "p2", requiredQty: null, requiredValue: null }],
  });
});

console.log(`\n${passed} passed`);
