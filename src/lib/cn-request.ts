/**
 * CN Request values shared by the browser form and the server validator.
 *
 * The value is the canonical value persisted by the API/database contract; the label is what the user sees.
 * Price difference retains its existing CD domain value. Freight is canonical end-to-end (legacy FRAT is
 * normalized only while historical data is being migrated).
 *
 * "Damage/Expiry" replaces the former "Damage". New requests store "Damage/Expiry"; historical rows that still hold "Damage"
 * are NOT rewritten — they are read through canonicalCnType, so they display and behave as Damage/Expiry.
 */
export const CN_TYPE_VALUES = ["CD", "Freight", "Scheme", "Demo", "Damage/Expiry", "Other"] as const;
export type CnType = (typeof CN_TYPE_VALUES)[number];

export const CN_TYPE_OPTIONS: { value: CnType; label: string }[] = [
  { value: "CD", label: "Price diff" },
  { value: "Freight", label: "Freight" },
  { value: "Scheme", label: "Scheme" },
  { value: "Demo", label: "Demo" },
  { value: "Damage/Expiry", label: "Damage/Expiry" },
  { value: "Other", label: "Other" },
];

export interface CnTypeLabels {
  priceDifference: string;
  freight: string;
  scheme: string;
  demo: string;
  damageExpiry: string;
  other: string;
}

/** Display-only CN Type terminology. Canonical values sent to and stored by the API remain unchanged. */
export function cnTypeLabel(value: string, labels?: CnTypeLabels): string {
  const canonical = canonicalCnType(value);
  if (!labels) return CN_TYPE_OPTIONS.find((option) => option.value === canonical)?.label ?? canonical;
  if (canonical === "CD") return labels.priceDifference;
  if (canonical === "Freight") return labels.freight;
  if (canonical === "Scheme") return labels.scheme;
  if (canonical === "Demo") return labels.demo;
  if (canonical === "Damage/Expiry") return labels.damageExpiry;
  if (canonical === "Other") return labels.other;
  return canonical;
}

/**
 * Read compatibility for legacy persisted values: FRAT (converted by a migration, kept as a safety net) and the former
 * "Damage" (never migrated — it simply reads as the renamed "Damage/Expiry"). Everything else passes through unchanged.
 */
export function canonicalCnType(value: string): string {
  if (value === "FRAT") return "Freight";
  if (value === "Damage") return "Damage/Expiry";
  return value;
}

export const CN_PAYMENT_STATUSES = ["Pending", "Not Paid", "Partial Paid", "Paid"] as const;
export type CnPaymentStatus = (typeof CN_PAYMENT_STATUSES)[number];
export const CN_PAYMENT_STATUS_VALUES = ["PENDING", "NOT_PAID", "PARTIAL_PAID", "PAID"] as const;
export type CnPaymentStatusValue = (typeof CN_PAYMENT_STATUS_VALUES)[number];

export const CN_REQUEST_DETAILS_REQUIRED_MESSAGE = "Details is required.";

/** New CN Requests require meaningful details; historical rows may still contain null. */
export function validateCnRequestDetails(value: string, requiredMessage = CN_REQUEST_DETAILS_REQUIRED_MESSAGE): string | null {
  return value.trim() ? null : requiredMessage;
}

export const CN_REJECTION_REASON_VALUES = [
  "BILLING_CONDITION_NOT_MET",
  "PAYMENT_CONDITION_NOT_MET",
  "OTHER",
] as const;
export type CnRejectionReason = (typeof CN_REJECTION_REASON_VALUES)[number];

export const CN_REJECTION_REASON_REQUIRED_MESSAGE = "Select a rejection reason.";
export const CN_REJECTION_DETAILS_REQUIRED_MESSAGE = "Other Reason is required.";

/** Shared browser validation; the server independently applies the same domain rules. */
export function validateCnRejection(
  reason: CnRejectionReason | "",
  rejectionReasonDetails: string,
  messages: { reasonRequired: string; detailsRequired: string } = {
    reasonRequired: CN_REJECTION_REASON_REQUIRED_MESSAGE,
    detailsRequired: CN_REJECTION_DETAILS_REQUIRED_MESSAGE,
  },
): string | null {
  if (!reason) return messages.reasonRequired;
  if (reason === "OTHER" && !rejectionReasonDetails.trim()) return messages.detailsRequired;
  return null;
}

export const CN_ACCEPTANCE_STATUS_VALUES = ["ACCEPTED_NOT_POSTED", "POSTED_IN_LEDGER"] as const;
export type CnAcceptanceStatus = (typeof CN_ACCEPTANCE_STATUS_VALUES)[number];
export const CN_ACCEPTANCE_REASON_VALUES = ["PAYMENT_PENDING", "OTHER"] as const;
export type CnAcceptanceReason = (typeof CN_ACCEPTANCE_REASON_VALUES)[number];

/**
 * CN follow-up task rendered in Daily Work → Recovery. New payment workflows use a stable payment-event
 * task id; historical rows continue to use the CnRequest id + legacy taskDate compatibility path.
 */
export type CnTaskKind = "CN_RECOVERY" | "CN_TASK";
/** PAYMENT_PENDING → CN_RECOVERY (with amount); OTHER → CN_TASK (no amount). */
export function cnTaskKindForReason(reason: CnAcceptanceReason | null | undefined): CnTaskKind {
  return reason === "PAYMENT_PENDING" ? "CN_RECOVERY" : "CN_TASK";
}
/** Only PAYMENT_PENDING carries the CN amount into the Recovery task; OTHER never does. */
export function cnTaskAmount(reason: CnAcceptanceReason | null | undefined, amount: number | null): number | null {
  return cnTaskKindForReason(reason) === "CN_RECOVERY" ? amount : null;
}

export interface CnTaskDto {
  taskId: string | null; // null only for a historical CnRequest.taskDate task
  cnRequestId: string;
  dealerId: string;
  taskType: "CN_REQUEST"; // authoritative task origin for Today's Auto Tasks
  planType: "RECOVERY"; // authoritative Daily Work destination for CN follow-up tasks
  partyName: string;
  cnType: string;
  details: string | null;
  amount: number | null; // the CN request amount (informational)
  reason: CnAcceptanceReason | null;
  kind: CnTaskKind; // CN_RECOVERY (Payment Pending, carries amount) | CN_TASK (Other, no amount)
  recoveryAmount: number | null; // amount ONLY for CN_RECOVERY; null for CN_TASK
  taskDate: string | null; // "YYYY-MM-DD" chosen by the SO; null = pending/unscheduled
  taskRescheduled: boolean; // sticky: once the SO changes the system date, it remains true
  confirmed: boolean; // explicit "confirmed for today's Daily Work" acknowledgement; independent of payment/taskStatus
  acceptanceDate: string | null; // India business date derived from the authoritative acceptedAt timestamp
  expiryDate: string | null; // inclusive final scheduling date; null only for historical rows without expiry data
  paymentStatus: string | null;
}

export const CN_ACCEPTANCE_STATUS_REQUIRED_MESSAGE = "Select an acceptance status.";
export const CN_ACCEPTANCE_REASON_REQUIRED_MESSAGE = "Select an acceptance reason.";
export const CN_ACCEPTANCE_DETAILS_REQUIRED_MESSAGE = "Other Reason is required.";
export const CN_EXPIRY_DAYS_REQUIRED_MESSAGE = "CN Expiry Date is required.";
export const CN_EXPIRY_DAYS_INVALID_MESSAGE = "Enter a valid CN Expiry Date.";
export const CN_POSTED_AMOUNT_REQUIRED_MESSAGE = "Posted Amount is required.";
export const CN_POSTED_AMOUNT_INVALID_MESSAGE = "Posted Amount must be greater than 0.";
export const CN_OUTSTANDING_AMOUNT_REQUIRED_MESSAGE = "Outstanding Amount is required.";
export const CN_OUTSTANDING_AMOUNT_INVALID_MESSAGE = "Outstanding Amount must be greater than 0.";
export const CN_PAYMENT_STATUS_REQUIRED_MESSAGE = "Select a payment status.";
export const CN_PAYMENT_DATE_REQUIRED_MESSAGE = "Payment Date is required.";
export const CN_PAYMENT_DATE_INVALID_MESSAGE = "Enter a valid Payment Date.";
export const CN_PAYMENT_AMOUNT_REQUIRED_MESSAGE = "Amount Paid is required.";
export const CN_PAYMENT_AMOUNT_INVALID_MESSAGE = "Amount Paid must be greater than 0 and less than the current outstanding amount.";
export const CN_FOLLOW_UP_DATE_REQUIRED_MESSAGE = "Follow-up Date is required.";
export const CN_REMAINING_AMOUNT_REQUIRED_MESSAGE = "Remaining Amount is required.";
export const CN_REMAINING_AMOUNT_INVALID_MESSAGE = "Remaining Amount must be greater than 0 and cannot exceed the original outstanding amount.";
export const CN_TASK_DATE_OUTSIDE_EXPIRY_MESSAGE = "Selected task date is outside the CN expiry period.";
export const CN_TASK_DATE_SUNDAY_MESSAGE = "Sunday is not a valid CN task date.";
export const CN_TASK_DEFAULT_DATE_UNAVAILABLE_MESSAGE = "The CN expiry period does not include the next working day.";
export const CN_WORKING_REQUIRED_MESSAGE = "CN Working document is required.";
export const CN_WORKING_MAX_BYTES = 3_500_000;
export const CN_WORKING_PDF_MIME = "application/pdf";
export const CN_WORKING_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function validateCnAcceptance(input: {
  status: CnAcceptanceStatus | "";
  reason: CnAcceptanceReason | "";
  acceptanceReasonDetails: string;
  expiryDays: string | number | null | undefined;
  postedAmount: string | number | null | undefined;
  outstandingAmount?: string | number | null | undefined;
  hasFile: boolean;
}, messages: {
  statusRequired: string; reasonRequired: string; detailsRequired: string;
  expiryRequired: string; expiryInvalid: string; postedAmountRequired: string; postedAmountInvalid: string;
  outstandingRequired: string; outstandingInvalid: string; workingRequired: string;
} = {
  statusRequired: CN_ACCEPTANCE_STATUS_REQUIRED_MESSAGE,
  reasonRequired: CN_ACCEPTANCE_REASON_REQUIRED_MESSAGE,
  detailsRequired: CN_ACCEPTANCE_DETAILS_REQUIRED_MESSAGE,
  expiryRequired: CN_EXPIRY_DAYS_REQUIRED_MESSAGE,
  expiryInvalid: CN_EXPIRY_DAYS_INVALID_MESSAGE,
  postedAmountRequired: CN_POSTED_AMOUNT_REQUIRED_MESSAGE,
  postedAmountInvalid: CN_POSTED_AMOUNT_INVALID_MESSAGE,
  outstandingRequired: CN_OUTSTANDING_AMOUNT_REQUIRED_MESSAGE,
  outstandingInvalid: CN_OUTSTANDING_AMOUNT_INVALID_MESSAGE,
  workingRequired: CN_WORKING_REQUIRED_MESSAGE,
}): string | null {
  if (!input.status) return messages.statusRequired;
  if (input.status === "ACCEPTED_NOT_POSTED" && !input.reason) return messages.reasonRequired;
  if (input.status === "ACCEPTED_NOT_POSTED" && input.reason === "OTHER" && !input.acceptanceReasonDetails.trim()) {
    return messages.detailsRequired;
  }
  if (input.status === "ACCEPTED_NOT_POSTED") {
    if (input.expiryDays === "" || input.expiryDays == null) return messages.expiryRequired;
    const expiryDays = Number(input.expiryDays);
    if (!Number.isSafeInteger(expiryDays) || expiryDays <= 0 || expiryDays > 2_147_483_647) {
      return messages.expiryInvalid;
    }
  }
  if (input.status === "ACCEPTED_NOT_POSTED" && input.reason === "PAYMENT_PENDING") {
    if (input.outstandingAmount === "" || input.outstandingAmount == null) return messages.outstandingRequired;
    const amount = Number(input.outstandingAmount);
    if (!Number.isFinite(amount) || amount <= 0) return messages.outstandingInvalid;
  }
  if (input.status === "POSTED_IN_LEDGER") {
    if (input.postedAmount === "" || input.postedAmount == null) return messages.postedAmountRequired;
    const postedAmount = Number(input.postedAmount);
    if (!Number.isFinite(postedAmount) || postedAmount <= 0) return messages.postedAmountInvalid;
  }
  if (!input.hasFile) return messages.workingRequired;
  return null;
}

export function paymentStatusLabel(status: string | null | undefined, labels: { pending: string; notPaid: string; partialPaid: string; paid: string } = {
  pending: "Pending", notPaid: "Not Paid", partialPaid: "Partial Paid", paid: "Paid",
}): string {
  if (status === "PENDING" || status === "Pending") return labels.pending;
  if (status === "NOT_PAID" || status === "Not Paid") return labels.notPaid;
  if (status === "PARTIAL_PAID" || status === "Partial Paid") return labels.partialPaid;
  if (status === "PAID" || status === "Paid") return labels.paid;
  return status ?? "—";
}

export const CN_REQUEST_STATUSES = {
  SUBMITTED: "SUBMITTED",
  REJECTED: "REJECTED",
  ACCEPTED_NOT_POSTED: "ACCEPTED_NOT_POSTED",
  POSTED_IN_LEDGER: "POSTED_IN_LEDGER",
  LEGACY_ACCEPTED: "ACCEPTED",
  LEGACY_APPROVED: "APPROVED",
} as const;

export type CnRequestView = "submitted" | "rejected" | "accepted-not-posted" | "posted-in-ledger";

/** Lifecycle status families. Accepted tab membership is additionally derived from current payment status. */
export const CN_REQUEST_VIEW_STATUSES: Record<CnRequestView, readonly string[]> = {
  submitted: [CN_REQUEST_STATUSES.SUBMITTED],
  rejected: [CN_REQUEST_STATUSES.REJECTED],
  "accepted-not-posted": [CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED],
  "posted-in-ledger": [
    CN_REQUEST_STATUSES.POSTED_IN_LEDGER,
    CN_REQUEST_STATUSES.LEGACY_ACCEPTED,
    CN_REQUEST_STATUSES.LEGACY_APPROVED,
  ],
};

export function isCnRequestView(value: string | null | undefined): value is CnRequestView {
  return value === "submitted" || value === "rejected" || value === "accepted-not-posted" || value === "posted-in-ledger";
}

/** Identifiers for the row "⋮" action menu on the CN Requests table. */
export type CnActionMenuItemId = "VIEW_DETAILS" | "DOWNLOAD_CN_WORKING" | "DOWNLOAD_FINAL_CN";

export interface CnActionMenuItem {
  id: CnActionMenuItemId;
  labelKey: string;
  enabled: boolean;
}

/**
 * Pure composition of the CN Requests row action menu, shared by the UI and its tests.
 * - Every view offers View Details (the existing details modal).
 * - The Accepted section additionally offers a download of the Admin-uploaded CN Working attachment, labelled
 *   "Download CN Workaround" for Accepted / Not Posted and "Download CN" for Posted in Ledger. The download is
 *   disabled when no attachment exists. Submitted / Rejected never expose a download.
 */
export function cnActionMenuItems(opts: {
  section: "submitted-rejected" | "accepted";
  view: CnRequestView;
  hasWorking: boolean;
  /** A Final CN exists (uploaded when Paid was verified). Adds its own download; CN Working keeps its own item. */
  hasFinalCn?: boolean;
}): CnActionMenuItem[] {
  const items: CnActionMenuItem[] = [
    { id: "VIEW_DETAILS", labelKey: "cn_requests.action.view_details", enabled: true },
  ];
  if (opts.section === "accepted") {
    items.push({
      id: "DOWNLOAD_CN_WORKING",
      labelKey: opts.view === "posted-in-ledger" ? "cn_requests.action.download_cn" : "cn_requests.action.download_cn_workaround",
      enabled: opts.hasWorking,
    });
    if (opts.hasFinalCn) {
      items.push({ id: "DOWNLOAD_FINAL_CN", labelKey: "cn_requests.action.download_final_cn", enabled: true });
    }
  }
  return items;
}

export function cnRequestDisplayStatus(status: string): "SUBMITTED" | "REJECTED" | "ACCEPTED_NOT_POSTED" | "POSTED_IN_LEDGER" {
  if (status === CN_REQUEST_STATUSES.REJECTED) return "REJECTED";
  if (status === CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED) return "ACCEPTED_NOT_POSTED";
  if (CN_REQUEST_VIEW_STATUSES["posted-in-ledger"].includes(status)) return "POSTED_IN_LEDGER";
  return "SUBMITTED";
}

export type CnRequestCurrentDisplayStatus = ReturnType<typeof cnRequestDisplayStatus> | "RETURNED_FROM_LEDGER";

/**
 * Display-only ledger state. The persisted POSTED_IN_LEDGER lifecycle value proves the CN reached the ledger;
 * a later non-Paid payment status means it has returned to CN Working Shared without erasing that history.
 */
export function cnRequestCurrentDisplayStatus(status: string, paymentStatus: string | null | undefined): CnRequestCurrentDisplayStatus {
  const lifecycleStatus = cnRequestDisplayStatus(status);
  if (lifecycleStatus === "POSTED_IN_LEDGER" && paymentStatus !== "Paid") return "RETURNED_FROM_LEDGER";
  return lifecycleStatus;
}

export const CN_REQUEST_TIME_ZONE = "Asia/Kolkata";

/** Calendar date in the application's business timezone, avoiding elapsed-24-hour and UTC-boundary errors. */
export function cnRequestBusinessDateKey(value: Date | string, timeZone = CN_REQUEST_TIME_ZONE): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: "year" | "month" | "day") => parts.find((item) => item.type === type)?.value;
  const year = part("year"), month = part("month"), day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function isCnBusinessDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isCnSundayDateKey(value: string): boolean {
  return isCnBusinessDateKey(value) && new Date(`${value}T00:00:00.000Z`).getUTCDay() === 0;
}

/** The immediate calendar day after `value`, advancing once more when that day is Sunday. */
export function nextCnWorkingDateKey(value: Date | string): string | null {
  const current = cnRequestBusinessDateKey(value);
  if (!current) return null;
  const next = new Date(`${current}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  if (next.getUTCDay() === 0) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Inclusive expiry: day 1 is the Admin acceptance business date. */
export function cnRequestExpiryDateKey(acceptedAt: Date | string, expiryDays: number | null | undefined): string | null {
  if (expiryDays == null || !Number.isSafeInteger(expiryDays) || expiryDays <= 0) return null;
  const acceptedDate = cnRequestBusinessDateKey(acceptedAt);
  if (!acceptedDate) return null;
  const result = new Date(`${acceptedDate}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + expiryDays - 1);
  return Number.isNaN(result.getTime()) ? null : result.toISOString().slice(0, 10);
}

export function isCnTaskDateWithinExpiry(
  taskDate: string,
  acceptedAt: Date | string,
  expiryDays: number,
): boolean {
  if (!isCnBusinessDateKey(taskDate) || isCnSundayDateKey(taskDate)) return false;
  const acceptanceDate = cnRequestBusinessDateKey(acceptedAt);
  const expiryDate = cnRequestExpiryDateKey(acceptedAt, expiryDays);
  return !!acceptanceDate && !!expiryDate && taskDate >= acceptanceDate && taskDate <= expiryDate;
}

/** Inclusive calendar days: the submission date is Day 1, regardless of the timestamps' time of day. */
export function inclusiveCnRequestDays(start: Date | string, end: Date | string): number | null {
  const startKey = cnRequestBusinessDateKey(start);
  const endKey = cnRequestBusinessDateKey(end);
  if (!startKey || !endKey) return null;
  const startDay = Date.parse(`${startKey}T00:00:00Z`);
  const endDay = Date.parse(`${endKey}T00:00:00Z`);
  return Math.max(1, Math.round((endDay - startDay) / 86_400_000) + 1);
}

export interface CnRequestAgeInput {
  status: string;
  createdAt: Date | string;
  acceptedAt?: Date | string | null;
  rejectedAt?: Date | string | null;
  postedAt?: Date | string | null;
}

/** Resolve the authoritative endpoint for the request's current stage, then count inclusive calendar days. */
export function cnRequestAgeDays(request: CnRequestAgeInput, now: Date = new Date()): number | null {
  const displayStatus = cnRequestDisplayStatus(request.status);
  const endpoint = displayStatus === "SUBMITTED" ? now
    : displayStatus === "REJECTED" ? request.rejectedAt
      : displayStatus === "ACCEPTED_NOT_POSTED" ? request.acceptedAt
        : request.postedAt;
  return endpoint ? inclusiveCnRequestDays(request.createdAt, endpoint) : null;
}

export function formatCnRequestDays(days: number | null, labels: { day: string; days: string } = { day: "Day", days: "Days" }): string {
  return days == null ? "—" : `${days} ${days === 1 ? labels.day : labels.days}`;
}

export interface CreateCnRequestPayload {
  dealerId: string;
  cnType: CnType;
  officerId?: string;
  details: string;
}

/** Build the exact JSON body sent by the Create CN Request form. */
export function buildCreateCnRequestPayload(input: {
  dealerId: string;
  cnType: CnType;
  officerId?: string;
  details: string;
}): CreateCnRequestPayload {
  const details = input.details.trim();
  return {
    dealerId: input.dealerId,
    cnType: input.cnType,
    officerId: input.officerId || undefined,
    details,
  };
}

/* ------------------------------------------- Excel export (Admin) ------------------------------------------- */

/** The ONLY columns of the CN Requests export, in order. Nothing else (amounts, payment, status, ids, files) is ever exported. */
export const CN_EXPORT_COLUMNS = [
  { key: "dealer", label: "Dealer", width: 38 },
  { key: "cnType", label: "CN Type", width: 18 },
  { key: "employeeName", label: "Employee Name", width: 28 },
  { key: "state", label: "State", width: 22 },
  { key: "territory", label: "Territory", width: 26 },
] as const;
export type CnExportRow = Record<(typeof CN_EXPORT_COLUMNS)[number]["key"], string>;

export const NO_CN_EXPORT_MESSAGE = "There are no CN Requests to export in this tab.";
const CN_EXPORT_VIEW_NAME: Record<CnRequestView, string> = {
  submitted: "Submitted", rejected: "Rejected", "accepted-not-posted": "CN-Working-Shared", "posted-in-ledger": "Posted-in-Ledger",
};
/** e.g. CN-Requests-CN-Working-Shared-2026-10-09.xlsx (the date is the business date, IST). */
export function cnExportFilename(view: CnRequestView, date: Date = new Date()): string {
  return `CN-Requests-${CN_EXPORT_VIEW_NAME[view]}-${cnRequestBusinessDateKey(date) ?? date.toISOString().slice(0, 10)}.xlsx`;
}
/** Project request rows onto the five export columns. A missing value stays an empty cell — nothing is invented. */
export function toCnExportRows(
  rows: { partyName: string | null; cnType: string | null; employeeName: string | null; state: string | null; territory: string | null }[],
  labels?: CnTypeLabels,
): CnExportRow[] {
  return rows.map((r) => ({
    dealer: r.partyName?.trim() ?? "",
    cnType: r.cnType ? cnTypeLabel(r.cnType, labels) : "",
    employeeName: r.employeeName?.trim() ?? "",
    state: r.state?.trim() ?? "",
    territory: r.territory?.trim() ?? "",
  }));
}
