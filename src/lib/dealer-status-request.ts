/**
 * Dealer Status Change Requests (Territory Mapping) — pure rules shared by the service and the screen.
 * A request only REPORTS a problem with a dealer; it never changes the dealer's status.
 */
/** The reasons a Sales Officer / Regional Manager can CHOOSE for a new request, in display order. */
export const DEALER_STATUS_REASONS = ["INACTIVE", "LEGAL", "PARTY_IN_PLANNING", "OTHER"] as const;
export type SelectableStatusReason = (typeof DEALER_STATUS_REASONS)[number];
/** Reasons that older requests were saved with. They are no longer selectable but stay readable under their ORIGINAL meaning (never mapped onto the new ones). */
export const LEGACY_DEALER_STATUS_REASONS = ["DOES_NOT_EXIST", "PARTY_CLOSED"] as const;
export type DealerStatusReason = SelectableStatusReason | (typeof LEGACY_DEALER_STATUS_REASONS)[number];
export const DEALER_STATUS_REQUEST_STATES = ["PENDING", "RESOLVED"] as const;
export type DealerStatusRequestState = (typeof DEALER_STATUS_REQUEST_STATES)[number];

export const DEALER_STATUS_REASON_LABELS: Record<DealerStatusReason, string> = {
  INACTIVE: "Inactive",
  LEGAL: "Legal",
  PARTY_IN_PLANNING: "Party In Planning",
  OTHER: "Other",
  DOES_NOT_EXIST: "Does Not Exist",
  PARTY_CLOSED: "Party Closed",
};
export const STATUS_REQUEST_DESCRIPTION_MAX = 500;
export const STATUS_REQUEST_NOTES_MAX = 500;

/** A reason a NEW request may use (legacy values are rejected for new requests). */
export const isDealerStatusReason = (v: unknown): v is SelectableStatusReason => typeof v === "string" && (DEALER_STATUS_REASONS as readonly string[]).includes(v);
export const cleanRequestText = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

/** Returns the problem (a user-facing message) or null when the input is a valid request. Shared by the screen and the server. */
export function validateStatusRequest(input: { reason?: unknown; description?: unknown }): string | null {
  if (!isDealerStatusReason(input.reason)) return "Choose a reason: Inactive, Legal, Party In Planning or Other.";
  // Only "Other" carries a reason text; a leftover text sent with another choice is ignored, never validated or stored.
  const description = input.reason === "OTHER" ? cleanRequestText(input.description) : "";
  if (input.reason === "OTHER" && !description) return "Enter a reason when you choose Other.";
  if (description.length > STATUS_REQUEST_DESCRIPTION_MAX) return `The description can be at most ${STATUS_REQUEST_DESCRIPTION_MAX} characters.`;
  return null;
}
