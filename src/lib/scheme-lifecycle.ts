/**
 * View Plan lifecycle classification for ONE dealer scheme plan — the single source of truth shared by the
 * client (row filtering / grouping) and mirrored by the server summary aggregation, so a scheme's parent row,
 * its expanded dealer rows and its metrics are all derived from the SAME per-dealer rule.
 *
 * PURE (no React, no Prisma) so it can be unit-tested directly.
 *
 * Submitted vs Approved is decided per DEALER plan by the approval `planStatus` (NOT by Scheme Status, which
 * is a separate post-approval lifecycle) and NOT by the Scheme Master OPEN/CLOSED status (that only drives
 * Older Plans). A single scheme can therefore appear in BOTH Submitted and Approved when its dealers differ.
 */

export type SchemePlanLifecycle = "SUBMITTED" | "APPROVED" | "OLDER";

/** The minimal shape needed to classify a plan (a superset is fine — SchemePlan / server rows both satisfy it). */
export interface LifecyclePlan {
  /** True when the parent Scheme is CLOSED (Scheme Master OPEN/CLOSED). Drives Older Plans only. */
  schemeClosed?: boolean;
  planStatus: string;
  schemeStatus: string;
  adminBookingStatus: string | null;
  adminDocumentStatus: string | null;
}

/** Approval-workflow states that mean "submitted, awaiting approval". PENDING_RM = "Pending for RM",
 *  PENDING_APPROVAL = "Pending Approval" (Admin approval). */
const SUBMITTED_PLAN_STATES = new Set(["PENDING_RM", "PENDING_APPROVAL"]);

/**
 * The green "✓ Converted" ADMIN-FINAL state — identical to the "✓" branch of `schemeStatusMark`: the dealer's
 * conversion is CONVERTED and the Admin has verified booking Paid + document Received. Kept as a reusable
 * Scheme-Status helper (used by tests / any post-approval workflow); it does NOT drive Submitted vs Approved.
 */
export function isAdminFinalConverted(
  p: Pick<LifecyclePlan, "schemeStatus" | "adminBookingStatus" | "adminDocumentStatus">,
): boolean {
  return (
    p.schemeStatus === "CONVERTED" &&
    p.adminBookingStatus === "RECEIVED" &&
    (p.adminDocumentStatus === "RECEIVED_SOFT" || p.adminDocumentStatus === "RECEIVED_HARD")
  );
}

/**
 * Which View Plan tab a dealer plan belongs to — driven by PLAN STATUS (never Scheme Status):
 *   OLDER     — the parent Scheme is CLOSED (archive); takes precedence, unchanged behaviour.
 *   APPROVED  — planStatus APPROVED (regardless of Scheme Status: Pending / Converted / Enrolled / …).
 *   SUBMITTED — planStatus PENDING_RM or PENDING_APPROVAL (still in the approval workflow).
 * Returns null for editable states (DRAFT / RETURNED / REJECTED — Create Plan), which never reach View Plan;
 * a FUTURE_DRAFT quantity segment is DRAFT and therefore also stays out of Submitted.
 */
export function planLifecycle(p: LifecyclePlan): SchemePlanLifecycle | null {
  if (p.schemeClosed) return "OLDER";
  if (p.planStatus === "APPROVED") return "APPROVED";
  if (SUBMITTED_PLAN_STATES.has(p.planStatus)) return "SUBMITTED";
  return null; // DRAFT / RETURNED / REJECTED
}
