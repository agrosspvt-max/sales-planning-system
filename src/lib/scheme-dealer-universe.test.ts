/**
 * "Planned Dealers" denominator tests (`scheme-dealer-universe.ts`) + its interaction with tab filtering.
 * DB-free.  npx tsx src/lib/scheme-dealer-universe.test.ts
 */
import assert from "node:assert/strict";
import { combinedDealerUniverse } from "./scheme-dealer-universe";
import { planLifecycle, type LifecyclePlan } from "./scheme-lifecycle";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

/** Build N assignment rows for one officer with distinct dealer ids prefixed by the officer. */
const assign = (officerId: string, n: number, startAt = 1) =>
  Array.from({ length: n }, (_, i) => ({ officerId, dealerId: `${officerId}-d${startAt + i}` }));

/* ---------- Case A: one officer ---------- */
test("Case A: Subham has 20 assigned dealers, denominator = 20", () => {
  const assigns = assign("subham", 20);
  assert.equal(combinedDealerUniverse(["subham"], assigns), 20);
});

/* ---------- Case B: multiple officers, disjoint universes ---------- */
test("Case B: 20 + 30 + 15 across three officers = 65", () => {
  const assigns = [...assign("subham", 20), ...assign("rahul", 30), ...assign("abhinav", 15)];
  assert.equal(combinedDealerUniverse(["subham", "rahul", "abhinav"], assigns), 65);
});
test("Case B: only the scheme's officers count (a fourth officer's dealers are excluded)", () => {
  const assigns = [...assign("subham", 20), ...assign("rahul", 30), ...assign("other", 500)];
  assert.equal(combinedDealerUniverse(["subham", "rahul"], assigns), 50);
});

/* ---------- Case C: shared dealer must not be double-counted ---------- */
test("Case C: a dealer assigned to two officers is counted once", () => {
  // subham d1..d20 ; rahul d15..d44 → overlap d15..d20 (shared). Union = 44, not 50.
  const shared = ["s-d1", "s-d2", "shared-a", "shared-b"]; // subham set includes two shared ids
  const subham = shared.map((d) => ({ officerId: "subham", dealerId: d }));
  const rahul = ["shared-a", "shared-b", "r-d1", "r-d2", "r-d3"].map((d) => ({ officerId: "rahul", dealerId: d }));
  // subham unique: s-d1,s-d2,shared-a,shared-b (4) ; rahul adds r-d1,r-d2,r-d3 (+3) ; shared-a/b not recounted.
  assert.equal(combinedDealerUniverse(["subham", "rahul"], [...subham, ...rahul]), 7);
});

/* ---------- Case D: Submitted vs Approved use their own officer population ---------- */
test("Case D: Submitted and Approved denominators come from their own tab's officers", () => {
  const plan = (officerId: string, over: Partial<LifecyclePlan>): LifecyclePlan & { salesOfficerId: string } => ({
    salesOfficerId: officerId, schemeClosed: false, planStatus: "APPROVED", schemeStatus: "PENDING",
    adminBookingStatus: null, adminDocumentStatus: null, ...over,
  });
  // Scheme A by PLAN STATUS: D1(subham, Approved), D2(rahul, Pending), D3(subham, Approved), D4(rahul, Pending).
  const plans = [
    plan("subham", { planStatus: "APPROVED" }), plan("rahul", { planStatus: "PENDING_APPROVAL" }),
    plan("subham", { planStatus: "APPROVED" }), plan("rahul", { planStatus: "PENDING_APPROVAL" }),
  ];

  const approved = plans.filter((p) => planLifecycle(p) === "APPROVED");
  const submitted = plans.filter((p) => planLifecycle(p) === "SUBMITTED");
  assert.equal(approved.length, 2, "approved numerator = D1 + D3");
  assert.equal(submitted.length, 2, "submitted numerator = D2 + D4");

  const officersOf = (rows: { salesOfficerId: string }[]) => new Set(rows.map((r) => r.salesOfficerId));
  assert.deepEqual([...officersOf(approved)], ["subham"], "Approved tab officers = {subham} only");
  assert.deepEqual([...officersOf(submitted)], ["rahul"], "Submitted tab officers = {rahul} only");

  const assigns = [...assign("subham", 20), ...assign("rahul", 30)];
  assert.equal(combinedDealerUniverse(officersOf(approved), assigns), 20, "Approved denominator = subham's 20 (no rahul leak)");
  assert.equal(combinedDealerUniverse(officersOf(submitted), assigns), 30, "Submitted denominator = rahul's 30 (no subham leak)");
});

/* ---------- Edge ---------- */
test("Edge: no officers → 0", () => {
  assert.equal(combinedDealerUniverse([], assign("subham", 20)), 0);
});

console.log(`\n${passed} scheme-dealer-universe tests passed`);
