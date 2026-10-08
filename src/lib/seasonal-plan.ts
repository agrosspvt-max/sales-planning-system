/**
 * Seasonal Planning — pure rules (Party Planning · Phase 2). No database access: the server service applies these, the browser reuses the
 * display helpers, and they are unit-tested directly. Seasonal Plan approval is NOT a Party appointment: approval only makes a plan
 * "Pending"; "Appointed" + a date belong to the appointment event (see applyAppointment — intentionally not wired to any route yet).
 */

export const APPROVAL_STATUSES = ["DRAFT", "PENDING_RM", "PENDING_ADMIN", "APPROVED", "REJECTED"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type AppointmentStatus = "PENDING" | "APPOINTED";

export const PARTY_NAME_MAX = 200; // same limit as the existing Party Planning appointment plans

/** A plan is editable/deletable by its owner only before it has entered (or after it has left) review. */
export const EDITABLE_APPROVAL_STATUSES: readonly ApprovalStatus[] = ["DRAFT", "REJECTED"];
export const isEditable = (status: string): boolean => (EDITABLE_APPROVAL_STATUSES as readonly string[]).includes(status);

/** Display "Type" is DERIVED from the Market's origin — never chosen or stored by the user. */
export function derivedType(marketSource: string | null | undefined): "Existing" | "New" | null {
  if (marketSource === "EXISTING") return "Existing";
  if (marketSource === "REQUESTED") return "New";
  return null;
}

/** The Status column: "—" until final approval, then Pending (planned, awaiting the actual appointment), then Appointed. */
export function displayStatus(plan: { appointmentStatus: string | null }): "—" | "Pending" | "Appointed" {
  if (plan.appointmentStatus === "APPOINTED") return "Appointed";
  if (plan.appointmentStatus === "PENDING") return "Pending";
  return "—";
}

export function validatePartyName(value: unknown): string | null {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) return "Party Name is required.";
  if (name.length > PARTY_NAME_MAX) return `Party Name can be at most ${PARTY_NAME_MAX} characters.`;
  return null;
}
export const cleanPartyName = (value: string): string => value.replace(/\s+/g, " ").trim();

export type PlannerRole = "SALES_OFFICER" | "REGIONAL_MANAGER";

/**
 * Submit: DRAFT / REJECTED → PENDING_RM when the owner is a Sales Officer who has a Regional Manager above them, otherwise
 * (an RM's own plan, or an SO with no RM) straight to PENDING_ADMIN.
 */
export function submitTarget(current: string, ownerRole: PlannerRole, ownerHasRm: boolean): ApprovalStatus | null {
  if (!isEditable(current)) return null;
  return ownerRole === "SALES_OFFICER" && ownerHasRm ? "PENDING_RM" : "PENDING_ADMIN";
}

export type Decision = { by: "RM" | "ADMIN"; action: "approve" | "reject"; reason?: string };
export type Transition = { ok: true; approvalStatus: ApprovalStatus; finalApproval: boolean } | { ok: false; code: 409 | 422; message: string };

/** One review step. The RM acts only on PENDING_RM, Admin only on PENDING_ADMIN; a rejection always needs a reason. */
export function reviewTransition(current: string, decision: Decision): Transition {
  const expected: ApprovalStatus = decision.by === "RM" ? "PENDING_RM" : "PENDING_ADMIN";
  if (current !== expected) return { ok: false, code: 409, message: decision.by === "RM" ? "This plan is not waiting for RM review." : "This plan is not waiting for Admin review." };
  if (decision.action === "reject") {
    if (!decision.reason?.trim()) return { ok: false, code: 422, message: "A rejection reason is required." };
    return { ok: true, approvalStatus: "REJECTED", finalApproval: false };
  }
  return decision.by === "RM" ? { ok: true, approvalStatus: "PENDING_ADMIN", finalApproval: false } : { ok: true, approvalStatus: "APPROVED", finalApproval: true };
}

/** What final approval writes besides the approval status: the plan becomes Pending — never Appointed, and no appointment date. */
export function finalApprovalFields(market: { source: string; potential: string | null }) {
  return {
    appointmentStatus: "PENDING" as const,
    appointedAt: null,
    approvedMarketSource: market.source,
    approvedMarketPotential: market.potential,
  };
}

/**
 * The FUTURE appointment transition (not exposed by any route or UI yet — the repository has no Admin-confirmed appointment event).
 * Only an approved plan that is Pending can become Appointed, and only then is the appointment date recorded.
 */
export function applyAppointment(plan: { approvalStatus: string; appointmentStatus: string | null }, date: string): { appointmentStatus: "APPOINTED"; appointedAt: string } | null {
  if (plan.approvalStatus !== "APPROVED" || plan.appointmentStatus !== "PENDING") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { appointmentStatus: "APPOINTED", appointedAt: date };
}

/** Market Potential shown for a plan: the value approved by Admin once approved, otherwise the Market master's current value. */
export function shownMarketPotential(plan: { approvedMarketPotential: string | null; approvalStatus: string }, market: { potential: string | null }): string | null {
  return plan.approvalStatus === "APPROVED" ? plan.approvedMarketPotential : market.potential;
}
export function shownMarketSource(plan: { approvedMarketSource: string | null; approvalStatus: string }, market: { source: string }): string {
  return plan.approvalStatus === "APPROVED" && plan.approvedMarketSource ? plan.approvedMarketSource : market.source;
}

/**
 * The status a Seasonal Plan (the per-season header) shows in the list. It is DERIVED from its market rows — approval itself stays on each row:
 * no rows → Draft; every row approved → Approved; any row awaiting RM / Admin → Pending Approval; else any rejected → Needs Changes; else Draft.
 */
export type SheetStatus = "Draft" | "Pending Approval" | "Approved" | "Needs Changes";
export function seasonalSheetStatus(rows: { approvalStatus: string }[]): SheetStatus {
  if (rows.length === 0) return "Draft";
  if (rows.every((r) => r.approvalStatus === "APPROVED")) return "Approved";
  if (rows.some((r) => r.approvalStatus === "PENDING_RM" || r.approvalStatus === "PENDING_ADMIN")) return "Pending Approval";
  if (rows.some((r) => r.approvalStatus === "REJECTED")) return "Needs Changes";
  return "Draft";
}
/** Whether the caller can act on a row right now: an RM on their team's PENDING_RM rows, an Admin on PENDING_ADMIN rows. */
export function canReviewNow(row: { approvalStatus: string; ownerId: string }, viewer: { userId: string; role: "RM" | "ADMIN" | "OTHER"; teamIds?: readonly string[] }): boolean {
  if (viewer.role === "ADMIN") return row.approvalStatus === "PENDING_ADMIN";
  if (viewer.role === "RM") return row.approvalStatus === "PENDING_RM" && row.ownerId !== viewer.userId && (viewer.teamIds ?? []).includes(row.ownerId);
  return false;
}

export const MARKET_POTENTIAL_FILTERS = ["A", "B", "C"] as const;

/** Detail-page column filters: Market name contains `market` (case-insensitive) AND Market Potential equals `potential` ("" = All). */
export function filterSeasonalRows<T extends { marketName: string; marketPotential: string | null }>(rows: readonly T[], filters: { market: string; potential: string }): T[] {
  const needle = filters.market.trim().toLowerCase();
  const potential = (MARKET_POTENTIAL_FILTERS as readonly string[]).includes(filters.potential) ? filters.potential : "";
  return rows.filter((r) => (!needle || r.marketName.toLowerCase().includes(needle)) && (!potential || r.marketPotential === potential));
}
