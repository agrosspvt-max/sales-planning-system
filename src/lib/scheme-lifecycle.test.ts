/**
 * View Plan lifecycle classification tests (`scheme-lifecycle.ts`). DB-free.
 *   npx tsx src/lib/scheme-lifecycle.test.ts
 *
 * Core rule: Submitted vs Approved is driven by PLAN STATUS (PENDING_RM / PENDING_APPROVAL = Submitted;
 * APPROVED = Approved), NEVER by Scheme Status. Scheme Status (Pending / Converted / Enrolled …) is a
 * separate post-approval lifecycle and must not move an Approved plan out of Approved.
 */
import assert from "node:assert/strict";
import { planLifecycle, isAdminFinalConverted, type LifecyclePlan } from "./scheme-lifecycle";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const plan = (over: Partial<LifecyclePlan> = {}): LifecyclePlan => ({
  schemeClosed: false, planStatus: "PENDING_APPROVAL", schemeStatus: "PENDING",
  adminBookingStatus: null, adminDocumentStatus: null, ...over,
});

/* ---------- The five examples: PLAN STATUS controls the tab ---------- */
test("Ex1: Pending Admin Approval + Scheme PENDING → SUBMITTED", () => assert.equal(planLifecycle(plan({ planStatus: "PENDING_APPROVAL", schemeStatus: "PENDING" })), "SUBMITTED"));
test("Ex2: Pending Admin Approval + Scheme CONVERTED → SUBMITTED (Scheme Status ignored)", () => assert.equal(planLifecycle(plan({ planStatus: "PENDING_APPROVAL", schemeStatus: "CONVERTED" })), "SUBMITTED"));
test("Pending for RM → SUBMITTED", () => assert.equal(planLifecycle(plan({ planStatus: "PENDING_RM" })), "SUBMITTED"));
test("Ex3: Approved + Scheme PENDING → APPROVED", () => assert.equal(planLifecycle(plan({ planStatus: "APPROVED", schemeStatus: "PENDING" })), "APPROVED"));
test("Ex4: Approved + Scheme CONVERTED → APPROVED", () => assert.equal(planLifecycle(plan({ planStatus: "APPROVED", schemeStatus: "CONVERTED" })), "APPROVED"));
test("Ex5: Approved + admin-final green Converted (≈ Enrolled path) → APPROVED", () => assert.equal(planLifecycle(plan({ planStatus: "APPROVED", schemeStatus: "CONVERTED", adminBookingStatus: "RECEIVED", adminDocumentStatus: "RECEIVED_HARD" })), "APPROVED"));

/* ---------- Older + editable ---------- */
test("CLOSED scheme → OLDER regardless of plan status", () => assert.equal(planLifecycle(plan({ schemeClosed: true, planStatus: "APPROVED", schemeStatus: "CONVERTED" })), "OLDER"));
test("CLOSED scheme + pending → OLDER", () => assert.equal(planLifecycle(plan({ schemeClosed: true, planStatus: "PENDING_APPROVAL" })), "OLDER"));
test("Editable (DRAFT/RETURNED/REJECTED) → null; a FUTURE_DRAFT segment stays out of Submitted", () => {
  for (const s of ["DRAFT", "RETURNED", "REJECTED"]) assert.equal(planLifecycle(plan({ planStatus: s })), null);
});

/* ---------- Mixed scheme in both tabs ---------- */
test("A scheme with mixed dealers appears in BOTH Submitted and Approved", () => {
  const rows = [plan({ planStatus: "APPROVED" }), plan({ planStatus: "PENDING_APPROVAL" })];
  assert.ok(rows.some((r) => planLifecycle(r) === "APPROVED") && rows.some((r) => planLifecycle(r) === "SUBMITTED"));
});

/* ---------- isAdminFinalConverted remains a valid Scheme-Status helper (NOT tab classification) ---------- */
test("isAdminFinalConverted still identifies the green ✓ state", () => {
  assert.equal(isAdminFinalConverted({ schemeStatus: "CONVERTED", adminBookingStatus: "RECEIVED", adminDocumentStatus: "RECEIVED_SOFT" }), true);
  assert.equal(isAdminFinalConverted({ schemeStatus: "CONVERTED", adminBookingStatus: "RECEIVED", adminDocumentStatus: null }), false);
});

console.log(`\n${passed} scheme-lifecycle classification tests passed`);
