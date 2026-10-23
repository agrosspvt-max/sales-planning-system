/** Review outcomes are independent of the final CN lifecycle. Product prices are always per litre/kg. */
export const CN_REVIEW_TYPES = ["RATE_CONFIRMATION", "CN_APPROVAL"] as const;
export type CnReviewType = (typeof CN_REVIEW_TYPES)[number];
export type CnReviewStatus = "PENDING" | "CONFIRMED" | "REJECTED" | "REPLACED" | "CLOSED";
export interface CnReviewProduct {
  id: string;
  name: string;
  price: number | null;
}
export interface CnReview {
  id: string;
  cnRequestId: string;
  kind: CnReviewType;
  status: CnReviewStatus;
  assignedToId: string;
  assignedToName: string;
  sentByName: string;
  createdAt: string;
  respondedAt: string | null;
  note: string | null;
  products: CnReviewProduct[];
  fileName: string | null;
  mimeType: string | null;
  partyName?: string;
  cnType?: string;
  details?: string | null;
}
export const CN_REVIEW_LABELS = {
  "cn_requests.processing.tab": "Under Process",
  "cn_requests.processing.pending": "Under Process",
  "cn_requests.processing.rate_confirmed": "Rate Confirmed",
  "cn_requests.processing.rate_rejected": "Rate Denied",
  "cn_requests.processing.cn_confirmed": "CN Working Approved",
  "cn_requests.processing.cn_rejected": "CN Working Refused",
  "cn_requests.processing.replaced": "Replaced",
  "cn_requests.processing.closed": "Closed by CN decision",
  "cn_requests.processing.type": "Review Type",
  "cn_requests.processing.rate": "Rate Request",
  "cn_requests.processing.cn": "CN Working Approval",
  "cn_requests.processing.products": "Add Product",
  "cn_requests.processing.product": "Product",
  "cn_requests.processing.price": "Price (₹ per litre/kg)",
  "cn_requests.processing.depends": "Depends On",
  "cn_requests.processing.sender": "Requested By",
  "cn_requests.processing.send": "Send Request",
  "cn_requests.processing.replace": "Replace / Reassign",
  "cn_requests.processing.submit_prices": "Submit Prices",
  "cn_requests.processing.approve": "Approve",
  "cn_requests.processing.reject": "Reject Review",
  "cn_requests.processing.note": "Note / Rejection Reason",
  "cn_requests.processing.inbox": "CN Reviews Assigned to Me",
  "cn_requests.processing.empty": "No CN reviews awaiting your response.",
  "cn_requests.processing.history": "Review History",
  "cn_requests.processing.open": "Open Review",
  "cn_requests.processing.search": "Search…",
  "cn_requests.processing.choose": "Choose a person…",
  "cn_requests.processing.none": "No matching options.",
  "cn_requests.processing.remove": "Remove {name}",
  "cn_requests.processing.unavailable": "Unavailable product",
  "cn_requests.processing.bypass": "Reason for proceeding without confirmation",
  "cn_requests.processing.bypass_title": "Proceed without confirmation",
  "cn_requests.processing.bypass_continue": "Continue",
  "cn_requests.processing.bypass_hint": "Required while the latest review is pending or rejected.",
  "cn_requests.processing.sent": "Review requested",
  "cn_requests.processing.responded": "Review response submitted",
  "cn_requests.processing.cancelled": "Review replaced or closed",
  "cn_requests.processing.finalized": "CN decision after review",
  "cn_requests.processing.error.schema":
    "Under Process requires the CN review database update before it can be used.",
  "cn_requests.processing.error.invalid":
    "Select a review type, one eligible person, and the required products or CN Working document.",
  "cn_requests.processing.error.forbidden": "You cannot perform this CN review action.",
  "cn_requests.processing.error.changed":
    "This review has changed or is no longer pending. Refresh and try again.",
  "cn_requests.processing.error.price":
    "Enter a valid non-negative price with up to two decimal places for every selected product.",
  "cn_requests.processing.error.reason": "A rejection reason is required.",
  "cn_requests.processing.error.bypass":
    "Explain why you are proceeding without successful confirmation.",
} as const;
export type CnReviewLabelKey = keyof typeof CN_REVIEW_LABELS;
export function cnReviewStatusKey(review: Pick<CnReview, "kind" | "status">): CnReviewLabelKey {
  if (review.status === "PENDING") return "cn_requests.processing.pending";
  if (review.status === "REPLACED") return "cn_requests.processing.replaced";
  if (review.status === "CLOSED") return "cn_requests.processing.closed";
  return review.kind === "RATE_CONFIRMATION"
    ? review.status === "CONFIRMED"
      ? "cn_requests.processing.rate_confirmed"
      : "cn_requests.processing.rate_rejected"
    : review.status === "CONFIRMED"
      ? "cn_requests.processing.cn_confirmed"
      : "cn_requests.processing.cn_rejected";
}
export function validCnReviewPrice(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 9_999_999_999.99 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 0.0001
  );
}
