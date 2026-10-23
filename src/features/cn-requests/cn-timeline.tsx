"use client";

import { Check, Clock3, X } from "lucide-react";
import { accountSnapshotName } from "@/features/accounts/identity";
import { cnReviewStatusKey, type CnReview } from "@/lib/cn-review";
import { useLabel, useLabelResolver } from "@/features/labels/label-ui";
import { formatDateTimeDMY, formatDMY } from "@/lib/date-format";
import { paymentStatusLabel } from "@/lib/cn-request";
import { cnTimelineDaysFromSubmission, orderCnTimelineEntries, type CnTimelineEntry } from "@/lib/cn-timeline";

const money = (value: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value)}`;

export function CnTimeline({ entries, submittedAt }: { entries?: CnTimelineEntry[]; submittedAt?: string }) {
  const t = useLabelResolver();
  const submission = submittedAt ?? entries?.find((entry) => entry.kind === "SUBMITTED")?.occurredAt;
  const L = {
    title: useLabel("cn_requests.detail.timeline"), timeZone: useLabel("cn_requests.detail.time_zone"),
    unknown: useLabel("cn_requests.detail.time_unknown"), loading: useLabel("cn_requests.detail.timeline_loading"),
    day: useLabel("cn_requests.detail.timeline_day"), account: useLabel("cn_requests.detail.timeline_account"), unknownAccount: useLabel("cn_requests.detail.account_unknown"),
    reason: useLabel("cn_requests.rejection.reason"), other: useLabel("cn_requests.rejection.other"),
    billing: useLabel("cn_requests.rejection.billing_condition_not_met"), payment: useLabel("cn_requests.rejection.payment_condition_not_met"),
    pendingReason: useLabel("cn_requests.acceptance.payment_pending"),
    amountPaid: useLabel("cn_requests.payment.amount_paid"), outstanding: useLabel("cn_requests.payment.outstanding_amount"),
    system: useLabel("cn_requests.detail.timeline_system"), expiry: useLabel("cn_requests.detail.timeline_expiry"), previousExpiry: useLabel("cn_requests.detail.timeline_previous_expiry"),
    graceDays: useLabel("cn_requests.detail.timeline_grace_days"), graceEnds: useLabel("cn_requests.detail.timeline_grace_ends"), authorizedBy: useLabel("cn_requests.detail.timeline_authorized_by"),
    cycle: useLabel("cn_requests.detail.timeline_cycle"),
  };
  const titles = {
    REVIEW_SENT: t("cn_requests.processing.sent"), REVIEW_RESPONDED: t("cn_requests.processing.responded"), REVIEW_CANCELLED: t("cn_requests.processing.cancelled"), REVIEW_FINALIZED: t("cn_requests.processing.finalized"),
    SUBMITTED: useLabel("cn_requests.detail.timeline.SUBMITTED"),
    WORKING_SHARED: useLabel("cn_requests.detail.timeline.WORKING_SHARED"), REJECTED: useLabel("cn_requests.detail.timeline.REJECTED"),
    PAYMENT_REPORTED: useLabel("cn_requests.detail.timeline.PAYMENT_REPORTED"), PAYMENT_VERIFIED: useLabel("cn_requests.detail.timeline.PAYMENT_VERIFIED"),
    FINAL_CN_SHARED: useLabel("cn_requests.detail.timeline.FINAL_CN_SHARED"), POSTED_IN_LEDGER: useLabel("cn_requests.detail.timeline.POSTED_IN_LEDGER"),
    GRACE_GRANTED: useLabel("cn_requests.detail.timeline.GRACE_GRANTED"), GRACE_MIGRATED: useLabel("cn_requests.detail.timeline.GRACE_MIGRATED"),
    EXPIRY_SET: useLabel("cn_requests.detail.timeline.EXPIRY_SET"), ENTERED_GRACE: useLabel("cn_requests.detail.timeline.ENTERED_GRACE"), EXPIRED: useLabel("cn_requests.detail.timeline.EXPIRED"),
    REOPENED: useLabel("cn_requests.detail.timeline.REOPENED"), RETURNED: useLabel("cn_requests.detail.timeline.RETURNED"),
  };
  const paymentLabels = {
    pending: useLabel("cn_requests.payment.pending"), notPaid: useLabel("cn_requests.payment.not_paid"),
    partialPaid: useLabel("cn_requests.payment.partial_paid"), paid: useLabel("cn_requests.payment.paid"),
  };
  const reasonLabels: Record<string, string> = { BILLING_CONDITION_NOT_MET: L.billing, PAYMENT_CONDITION_NOT_MET: L.payment, OTHER: L.other, PAYMENT_PENDING: L.pendingReason };
  return <section className="min-w-0 border-t pt-4 md:border-l md:border-t-0 md:pl-6 md:pt-0" aria-label={L.title}>
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-1"><h3 className="font-semibold">{L.title}</h3><span className="text-xs text-muted-foreground">{L.timeZone}</span></div>
    {!entries ? <p role="status" className="text-sm text-muted-foreground">{L.loading}</p> : <ol className="ml-3 space-y-0 border-l-2 border-border">
      {orderCnTimelineEntries(entries).map((entry) => {
        // Derive from timestamps too: cached/older API responses may not carry daysFromSubmission.
        const days = submission ? cnTimelineDaysFromSubmission(submission, entry.occurredAt) : entry.daysFromSubmission ?? null;
        const rejected = entry.kind === "REJECTED" || entry.kind === "EXPIRED";
        const posted = entry.kind === "POSTED_IN_LEDGER";
        const tone = rejected ? "border-destructive bg-destructive/10 text-destructive" : posted ? "border-success bg-success/10 text-success" : "border-primary bg-background text-primary";
        return <li key={entry.id} className="relative pb-6 pl-6 last:pb-0" data-cn-event={entry.kind}>
          <span className={`absolute -left-[13px] top-0 flex h-6 w-6 items-center justify-center rounded-full border-2 ${tone}`} aria-hidden="true">
            {rejected ? <X className="h-3 w-3" /> : posted ? <Check className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
          </span>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className={`text-sm font-semibold ${rejected ? "text-destructive" : posted ? "text-success" : ""}`}>{titles[entry.kind]}{entry.paymentStatus ? ` · ${paymentStatusLabel(entry.paymentStatus, paymentLabels)}` : ""}</p>
            <div className="flex flex-col items-end gap-1">
              {days != null && <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary" data-testid="cn-timeline-day">{L.day.replace("{days}", String(days))}</span>}
              {entry.occurredAt ? <time dateTime={entry.occurredAt} className="text-xs text-muted-foreground">{formatDateTimeDMY(entry.occurredAt)}</time> : <span className="text-xs text-muted-foreground">{L.unknown}</span>}
            </div>
          </div>
          <p className="mt-1 break-words text-xs text-muted-foreground">{L.account}: {entry.system ? L.system : entry.actor ? accountSnapshotName(entry.actor) : L.unknownAccount}{entry.cycleNo && entry.cycleNo > 1 ? ` · ${L.cycle.replace("{cycle}", String(entry.cycleNo))}` : ""}</p>
          {entry.expiryDate && <p className="mt-1 text-xs text-muted-foreground" data-testid="cn-timeline-expiry">{L.expiry}: {formatDMY(entry.expiryDate)}{entry.previousExpiryDate ? ` (${L.previousExpiry}: ${formatDMY(entry.previousExpiryDate)})` : ""}{entry.graceDays ? ` · ${L.graceDays}: ${entry.graceDays}` : ""}{entry.graceEndDate ? ` · ${L.graceEnds}: ${formatDMY(entry.graceEndDate)}` : ""}</p>}
          {entry.authorizedBy && <p className="mt-1 break-words text-xs text-muted-foreground">{L.authorizedBy}: {entry.authorizedBy}</p>}
          {entry.note && <p className="mt-1 break-words text-xs italic text-muted-foreground">{entry.note}</p>}
          {entry.reviewKind && <p className="mt-1 text-sm">{t(entry.reviewKind === "RATE_CONFIRMATION" ? "cn_requests.processing.rate" : "cn_requests.processing.cn")}{entry.reviewStatus ? ` · ${t(cnReviewStatusKey({ kind: entry.reviewKind as CnReview["kind"], status: entry.reviewStatus as CnReview["status"] }))}` : ""}</p>}
          {entry.assignedToName && <p className="mt-1 text-sm">{t("cn_requests.processing.depends")}: {accountSnapshotName(entry.assignedToName)}</p>}
          {entry.products?.map(p => <p key={p.id} className="mt-1 text-sm">{p.name}: {p.price == null ? "—" : `${money(p.price)} (${t("cn_requests.processing.price")})`}</p>)}
          {entry.bypassReason && <p className="mt-1 whitespace-pre-wrap text-sm">{t("cn_requests.processing.bypass")}: {entry.bypassReason}</p>}
          {entry.destination && <p className="mt-1 text-sm">{t(entry.destination === "REJECTED" ? "cn_requests.view.rejected" : entry.destination === "POSTED_IN_LEDGER" ? "cn_requests.view.posted_in_ledger" : "cn_requests.view.accepted_not_posted")}</p>}
          {entry.reason && <p className="mt-1 text-sm">{L.reason}: {reasonLabels[entry.reason] ?? entry.reason}</p>}
          {entry.reasonDetails && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{entry.reasonDetails}</p>}
          {entry.fileName && <p className="mt-1 break-all text-xs text-muted-foreground">{entry.fileName}</p>}
          {entry.amountPaid != null && <p className="mt-1 text-xs text-muted-foreground">{L.amountPaid}: {money(entry.amountPaid)}</p>}
          {entry.outstandingAfter != null && <p className="mt-1 text-xs text-muted-foreground">{L.outstanding}: {money(entry.outstandingAfter)}</p>}
        </li>;
      })}
    </ol>}
  </section>;
}
