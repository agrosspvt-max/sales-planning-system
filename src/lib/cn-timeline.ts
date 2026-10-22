import { cnRequestBusinessDateKey, cnRequestDisplayStatus } from "./cn-request";

export type CnTimelineKind = "SUBMITTED" | "WORKING_SHARED" | "REJECTED" | "PAYMENT_REPORTED" | "PAYMENT_VERIFIED" | "FINAL_CN_SHARED" | "POSTED_IN_LEDGER";
export interface CnTimelineEntry {
  id: string;
  kind: CnTimelineKind;
  occurredAt: string | null;
  daysFromSubmission?: number | null;
  actor?: string;
  reason?: string | null;
  reasonDetails?: string | null;
  fileName?: string | null;
  paymentStatus?: string;
  amountPaid?: number | null;
  outstandingAfter?: number;
}
interface TimelineInput {
  status: string; createdAt: Date | string; acceptedAt?: Date | string | null;
  rejectedAt?: Date | string | null; postedAt?: Date | string | null;
  cnWorkingUploadedAt?: Date | string | null; cnWorkingFileName?: string | null;
  finalCnUploadedAt?: Date | string | null; finalCnFileName?: string | null;
  acceptanceReason?: string | null;
  rejectionReason?: string | null; rejectionReasonDetails?: string | null;
  actors?: Partial<Record<CnTimelineKind, string>>;
  payments?: Array<{ id: string; source: string; requestKey: string; createdAt: Date | string; actor: string; status: string; amountPaid: number | null; outstandingAfter: number }>;
}
const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** Calendar-day difference in IST: submission is Day 0, even when midnight is crossed in less than 24 hours. */
export function cnTimelineDaysFromSubmission(submittedAt: Date | string, occurredAt: Date | string | null): number | null {
  if (!occurredAt) return null;
  const start = cnRequestBusinessDateKey(submittedAt), end = cnRequestBusinessDateKey(occurredAt);
  if (!start || !end || end < start) return null;
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

/**
 * The Paid verification, Final CN and ledger posting are one transaction. Older payment rows used the
 * database clock while posting used the app clock (e.g. a 33ms difference), so raw sorting could invert
 * their causal order. Group only the Paid verification within one second of posting; later corrections
 * keep their actual chronological position. Recorded timestamps are never rewritten.
 */
export function orderCnTimelineEntries(entries: readonly CnTimelineEntry[]): CnTimelineEntry[] {
  const posted = entries.find((entry) => entry.kind === "POSTED_IN_LEDGER" && entry.occurredAt);
  const postingTime = posted?.occurredAt ? Date.parse(posted.occurredAt) : NaN;
  const verification = entries.find((entry) => entry.kind === "PAYMENT_VERIFIED" && entry.paymentStatus === "PAID"
    && entry.occurredAt && Math.abs(Date.parse(entry.occurredAt) - postingTime) <= 1000);
  const final = entries.find((entry) => entry.kind === "FINAL_CN_SHARED" && entry.occurredAt
    && Math.abs(Date.parse(entry.occurredAt) - postingTime) <= 1000);
  const anchor = Math.min(postingTime, final?.occurredAt ? Date.parse(final.occurredAt) : postingTime);
  const time = (entry: CnTimelineEntry) => entry === verification ? Math.min(Date.parse(entry.occurredAt!), anchor) : entry.occurredAt ? Date.parse(entry.occurredAt) : Infinity;
  const rank = (entry: CnTimelineEntry) => entry === verification ? 0 : entry === final ? 1 : entry === posted ? 2 : 0;
  return [...entries].sort((a, b) => (time(a) - time(b)) || rank(a) - rank(b));
}

/** Recorded stages only. A direct posting's mandatory uploaded file is not an intermediate Working Shared stage. */
export function buildCnTimeline(request: TimelineInput): CnTimelineEntry[] {
  const entries: CnTimelineEntry[] = [{ id: "submitted", kind: "SUBMITTED", occurredAt: iso(request.createdAt) }];
  const status = cnRequestDisplayStatus(request.status);
  const acceptedAt = iso(request.acceptedAt), postedAt = iso(request.postedAt), workingAt = iso(request.cnWorkingUploadedAt);
  const hasWorkingStage = status === "ACCEPTED_NOT_POSTED" || !!request.acceptanceReason
    || (request.payments ?? []).some((p) => p.source === "ACCEPTANCE")
    || !!(postedAt && ((acceptedAt && acceptedAt < postedAt) || (workingAt && workingAt < postedAt)));
  if (hasWorkingStage) entries.push({ id: "working", kind: "WORKING_SHARED", occurredAt: workingAt ?? acceptedAt, fileName: request.cnWorkingFileName });
  if (request.rejectedAt || status === "REJECTED") entries.push({ id: "rejected", kind: "REJECTED", occurredAt: iso(request.rejectedAt), reason: request.rejectionReason, reasonDetails: request.rejectionReasonDetails });
  for (const payment of request.payments ?? []) {
    // Initial payment state is part of the acceptance/posting action, not a separate report or verification.
    if (payment.source === "ACCEPTANCE" || payment.requestKey.startsWith("acceptance:")) continue;
    entries.push({ id: `payment:${payment.id}`, kind: payment.source === "ADMIN_VERIFY" ? "PAYMENT_VERIFIED" : "PAYMENT_REPORTED", occurredAt: iso(payment.createdAt), actor: payment.actor, paymentStatus: payment.status, amountPaid: payment.amountPaid, outstandingAfter: payment.outstandingAfter });
  }
  if (request.finalCnFileName || request.finalCnUploadedAt) entries.push({ id: "final-cn", kind: "FINAL_CN_SHARED", occurredAt: iso(request.finalCnUploadedAt), fileName: request.finalCnFileName });
  if (request.postedAt || status === "POSTED_IN_LEDGER") entries.push({ id: "posted", kind: "POSTED_IN_LEDGER", occurredAt: postedAt, ...(!hasWorkingStage ? { fileName: request.cnWorkingFileName } : {}) });
  // Stable insertion order resolves simultaneous actions; legacy unknown dates are explicit at the end.
  return orderCnTimelineEntries(entries)
    .map((entry) => ({ ...entry, actor: entry.actor ?? request.actors?.[entry.kind], daysFromSubmission: cnTimelineDaysFromSubmission(request.createdAt, entry.occurredAt) }));
}
