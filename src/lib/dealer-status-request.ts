/**
 * Dealer Status Change Requests (Territory Mapping) — pure rules shared by the service and the screen.
 * A request only REPORTS a problem with a dealer; it never changes the dealer's status.
 */
export const DEALER_STATUS_REASONS = ["DOES_NOT_EXIST", "PARTY_CLOSED", "OTHER"] as const;
export type DealerStatusReason = (typeof DEALER_STATUS_REASONS)[number];
export const DEALER_STATUS_REQUEST_STATES = ["PENDING", "RESOLVED"] as const;
export type DealerStatusRequestState = (typeof DEALER_STATUS_REQUEST_STATES)[number];

export const DEALER_STATUS_REASON_LABELS: Record<DealerStatusReason, string> = {
  DOES_NOT_EXIST: "Does Not Exist",
  PARTY_CLOSED: "Party Closed",
  OTHER: "Other",
};
export const STATUS_REQUEST_DESCRIPTION_MAX = 500;
export const STATUS_REQUEST_NOTES_MAX = 500;

export const isDealerStatusReason = (v: unknown): v is DealerStatusReason => typeof v === "string" && (DEALER_STATUS_REASONS as readonly string[]).includes(v);
export const cleanRequestText = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

/** Returns the problem (a user-facing message) or null when the input is a valid request. Shared by the screen and the server. */
export function validateStatusRequest(input: { reason?: unknown; description?: unknown }): string | null {
  if (!isDealerStatusReason(input.reason)) return "Choose a reason: Does Not Exist, Party Closed or Other.";
  const description = cleanRequestText(input.description);
  if (input.reason === "OTHER" && !description) return "Describe the reason when you choose Other.";
  if (description.length > STATUS_REQUEST_DESCRIPTION_MAX) return `The description can be at most ${STATUS_REQUEST_DESCRIPTION_MAX} characters.`;
  return null;
}
