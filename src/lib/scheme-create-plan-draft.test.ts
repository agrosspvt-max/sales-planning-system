import assert from "node:assert/strict";
import { editableDraftSchemeIds, mergeDealerIntoEditableWorkingSet } from "./scheme-create-plan-draft";

const schemeA = "fasal-vriddhi";
const schemeB = "vajeer-lelo";

assert.deepEqual([...editableDraftSchemeIds([])], []);
assert.deepEqual([...editableDraftSchemeIds([{ schemeId: schemeA, planStatus: "DRAFT" }])], [schemeA]);
assert.deepEqual([...editableDraftSchemeIds([
  { schemeId: schemeA, planStatus: "DRAFT" },
  { schemeId: schemeA, planStatus: "DRAFT" },
])], [schemeA]);
assert.deepEqual([...editableDraftSchemeIds([
  { schemeId: schemeA, planStatus: "PENDING_RM" },
  { schemeId: schemeA, planStatus: "DRAFT" },
])], [schemeA]);
assert.deepEqual([...editableDraftSchemeIds([{ schemeId: schemeA, planStatus: "PENDING_RM" }])], []);
assert.deepEqual([...editableDraftSchemeIds([{ schemeId: schemeB, planStatus: "PENDING_APPROVAL" }])], []);
assert.deepEqual([...editableDraftSchemeIds([{ schemeId: schemeA, planStatus: "RETURNED" }])], [schemeA]);
assert.deepEqual([...editableDraftSchemeIds([{ schemeId: schemeA, planStatus: "REJECTED" }])], []);

const existing = [{
  schemeId: schemeA,
  dealerId: "dealer-a",
  planStatus: "DRAFT",
  expectedBillingDate: "2026-10-01T00:00:00.000Z",
  numberOfSchemes: 2,
  soNote: "keep me",
  selectedOptionId: "option-1",
  prePlacementDays: 15,
}, {
  schemeId: schemeA,
  dealerId: "locked-dealer",
  planStatus: "PENDING_RM",
  expectedBillingDate: null,
  numberOfSchemes: 1,
}, {
  schemeId: schemeB,
  dealerId: "other-scheme-dealer",
  planStatus: "DRAFT",
  expectedBillingDate: null,
  numberOfSchemes: 1,
}];

const merged = mergeDealerIntoEditableWorkingSet(existing, schemeA, {
  dealerId: "dealer-b",
  expectedBillingDate: "2026-10-10",
  numberOfSchemes: 1,
  note: null,
  optionId: null,
  prePlacementDays: null,
});
assert.equal(merged.length, 2);
assert.equal(merged[0]?.dealerId, "dealer-a");
assert.equal(merged[0]?.note, "keep me");
assert.equal(merged[1]?.dealerId, "dealer-b");

const edited = mergeDealerIntoEditableWorkingSet(existing, schemeA, {
  dealerId: "dealer-a",
  expectedBillingDate: "2026-10-20",
  numberOfSchemes: 3,
  note: "updated",
  optionId: "option-2",
  prePlacementDays: 30,
});
assert.equal(edited.length, 1);
assert.equal(edited[0]?.expectedBillingDate, "2026-10-20");
assert.equal(edited[0]?.numberOfSchemes, 3);

console.log("12 Create Scheme Plan draft contracts passed");
