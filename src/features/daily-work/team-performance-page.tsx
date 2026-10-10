"use client";

import { DealerTableBody } from "@/features/dealers/dealer-table-ui";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Send, Lock } from "lucide-react";
import { api } from "@/lib/api-client";
import { RecoveryPaymentModeField } from "./recovery-payment-mode";
import { type DailyWorkType, type RecoveryPaymentMode, currentBusinessDate, rowTaskType } from "@/lib/daily-work";
import { formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DateInputDMY } from "@/components/ui/date-input-dmy";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";

/* --------------------------------- DTOs (mirror the service) --------------------------------- */

interface TeamRow {
  officerId: string; officerName: string; date: string;
  submitted: boolean; // the Daily Plan was submitted → there is something to view
  reportSubmittedAt: string | null; selfRating: number | null; rmRating: number | null;
}
interface TeamSummary {
  salesOfficers: number; totalDays: number; submittedReports: number;
  averageSelfRating: number | null; averageRmRating: number | null;
}
interface TeamPayload { from: string; to: string; summary: TeamSummary; rows: TeamRow[] }

interface ReviewDto { rating: number; reviewerId: string; reviewerName: string; reviewedAt: string }
// All of these are the EXISTING Daily Work report values (the review endpoint returns the standard section payloads).
interface DealerRow {
  entryId?: string; dealerId: string; dealerName: string; todaysPlan: number | null; todaysActual: number | null;
  entryType?: DailyWorkType; paymentMode?: RecoveryPaymentMode | null;
}
interface DealerPayload { dealers: DealerRow[]; autoTaskEntryIds?: string[]; calendarEntryIds?: string[] }
interface ApptRow { rowId: string; entryId?: string; dealerName: string; marketName: string; status: string | null }
interface ConvRow { dealerId: string; schemeId: string; dealerName: string; schemeName: string; todaysPlan: number | null; achievability: string | null }
interface SummaryDto {
  dealerVisits: number; newPartyVisits: number; others: string; visitsEntered: boolean;
  actualDealerVisits?: number | null; actualNewPartyVisits?: number | null;
}
interface ReviewDetail {
  officerId: string; officerName: string; workDate: string;
  sales: DealerPayload; recovery: DealerPayload;
  appointment: { rows: ApptRow[] }; conversion: { rows: ConvRow[] };
  summary: SummaryDto; selfRating: number | null; review: ReviewDto | null; reportSubmitted: boolean;
}

const ratingText = (v: number | null) => (v == null ? "—" : `${v} / 10`);
const dateText = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { dateStyle: "medium" });
const dash = <span className="text-muted-foreground">—</span>;

/* ==================================== Page ==================================== */

export function TeamPerformancePage() {
  const [from, setFrom] = useState(currentBusinessDate);
  const [to, setTo] = useState(currentBusinessDate);
  const [openOfficer, setOpenOfficer] = useState<{ officerId: string; date: string } | null>(null);
  const L = {
    title: useLabel("daily_work.team.title"),
    breadcrumb: useLabel("daily_work.team.breadcrumb"),
    planning: useLabel("daily_work.page.breadcrumb_planning"),
    subtitle: useLabel("daily_work.team.subtitle"),
    dateFrom: useLabel("daily_work.performance.date_from"),
    dateTo: useLabel("daily_work.performance.date_to"),
    colDate: useLabel("daily_work.performance.col.date"),
    colOfficer: useLabel("daily_work.team.col.sales_officer"),
    colSubmission: useLabel("daily_work.team.col.submission"),
    colSelf: useLabel("daily_work.team.col.self_rating"),
    colRm: useLabel("daily_work.team.col.rm_rating"),
    colAction: useLabel("daily_work.team.col.action"),
    view: useLabel("daily_work.team.action.view"),
    submitted: useLabel("daily_work.team.submitted"),
    notSubmitted: useLabel("daily_work.team.not_submitted"),
    empty: useLabel("daily_work.team.empty"),
    sSalesOfficers: useLabel("daily_work.team.summary.sales_officers"),
    sSubmitted: useLabel("daily_work.team.summary.submitted"),
    sNotSubmitted: useLabel("daily_work.team.summary.not_submitted"),
    sAvgSelf: useLabel("daily_work.team.summary.avg_self_rating"),
    sAvgRm: useLabel("daily_work.team.summary.avg_rm_rating"),
  };
  const query = new URLSearchParams({ from, to });
  const { data, isLoading } = useQuery<TeamPayload>({
    queryKey: ["team-performance", from, to],
    queryFn: () => api.get<TeamPayload>(`/api/daily-work/performance?${query.toString()}`),
  });

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: L.planning }, { label: L.breadcrumb }]} title={L.title} subtitle={L.subtitle} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5"><Label>{L.dateFrom}</Label><DateInputDMY value={from} onChange={(v) => setFrom(v || currentBusinessDate())} className="w-44" aria-label={L.dateFrom} /></div>
        <div className="space-y-1.5"><Label>{L.dateTo}</Label><DateInputDMY value={to} onChange={(v) => setTo(v || currentBusinessDate())} className="w-44" aria-label={L.dateTo} /></div>
      </div>

      {/* Team summary for the selected range. Counts are officer-days; averages exclude missing ratings. */}
      <div className="grid gap-3 rounded-lg border bg-background p-4 sm:grid-cols-3 lg:grid-cols-5">
        <SummaryStat label={L.sSalesOfficers} value={data ? String(data.summary.salesOfficers) : "—"} />
        <SummaryStat label={L.sSubmitted} value={data ? String(data.summary.submittedReports) : "—"} />
        <SummaryStat label={L.sNotSubmitted} value={data ? String(data.summary.totalDays - data.summary.submittedReports) : "—"} />
        <SummaryStat label={L.sAvgSelf} value={data ? ratingText(data.summary.averageSelfRating) : "—"} />
        <SummaryStat label={L.sAvgRm} value={data ? ratingText(data.summary.averageRmRating) : "—"} />
      </div>

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{L.colOfficer}</TableHead>
              <TableHead>{L.colDate}</TableHead>
              <TableHead>{L.colSubmission}</TableHead>
              <TableHead>{L.colSelf}</TableHead>
              <TableHead>{L.colRm}</TableHead>
              <TableHead className="text-right">{L.colAction}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (data?.rows.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">{L.empty}</TableCell></TableRow>
            ) : (
              data!.rows.map((r) => (
                <TableRow key={`${r.officerId}-${r.date}`}>
                  <TableCell className="font-medium">{r.officerName}</TableCell>
                  <TableCell className="whitespace-nowrap">{dateText(r.date)}</TableCell>
                  <TableCell>
                    {r.reportSubmittedAt
                      ? <Badge variant="success">{L.submitted}</Badge>
                      : <Badge variant="muted">{L.notSubmitted}</Badge>}
                  </TableCell>
                  <TableCell className="tabular-nums">{r.selfRating == null ? dash : ratingText(r.selfRating)}</TableCell>
                  <TableCell className="tabular-nums">{r.rmRating == null ? dash : ratingText(r.rmRating)}</TableCell>
                  <TableCell className="text-right">
                    {r.submitted ? (
                      <Button size="sm" variant="outline" onClick={() => setOpenOfficer({ officerId: r.officerId, date: r.date })}><Eye className="h-4 w-4" /> {L.view}</Button>
                    ) : dash}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {openOfficer && <DailyWorkReviewDialog officerId={openOfficer.officerId} workDate={openOfficer.date} onClose={() => setOpenOfficer(null)} />}
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/* ==================================== Review dialog (read-only detail + RM rating) ==================================== */

/**
 * Shared read-only Daily Work detail dialog. Used by RM Team Performance (readOnly=false → the RM can submit a
 * rating when none exists) and by the Admin Performance dashboard (readOnly=true → observe only, no rating control).
 */
export function DailyWorkReviewDialog({ officerId, workDate, onClose, readOnly = false }: { officerId: string; workDate: string; onClose: () => void; readOnly?: boolean }) {
  const qc = useQueryClient();
  const L = {
    title: useLabel("daily_work.review.title"),
    sales: useLabel("daily_work.section.sales"),
    recovery: useLabel("daily_work.section.recovery"),
    appointment: useLabel("daily_work.section.appointment"),
    conversion: useLabel("daily_work.section.scheme_conversion"),
    visits: useLabel("daily_work.section.visits"),
    others: useLabel("daily_work.section.others"),
    selfRating: useLabel("daily_work.review.self_rating"),
    reportPending: useLabel("daily_work.review.report_not_submitted"),
    close: useLabel("daily_work.action.cancel"),
    unavailable: useLabel("daily_work.review.unavailable"),
  };
  const { data, isLoading, error } = useQuery<ReviewDetail>({
    queryKey: ["team-review", officerId, workDate],
    queryFn: () => api.get<ReviewDetail>(`/api/daily-work/review?officerId=${officerId}&date=${workDate}`),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{L.title}{data ? ` — ${data.officerName}` : ""}</DialogTitle>
        </DialogHeader>
        {isLoading ? <Skeleton className="h-64 w-full" /> : error || !data ? (
          <p className="text-sm text-destructive">{(error as Error | null)?.message ?? L.unavailable}</p>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-muted-foreground">{data.officerName} · {workDate}</p>

            <DealerSection title={L.sales} rows={data.sales.dealers} autoEntryIds={data.sales.autoTaskEntryIds} calendarEntryIds={data.sales.calendarEntryIds} />
            <DealerSection title={L.recovery} rows={data.recovery.dealers} autoEntryIds={data.recovery.autoTaskEntryIds} calendarEntryIds={data.recovery.calendarEntryIds} recovery />
            <AppointmentSection title={L.appointment} rows={data.appointment.rows} />
            <ConversionSection title={L.conversion} rows={data.conversion.rows} />
            <VisitsSection title={L.visits} summary={data.summary} />
            <OthersSection title={L.others} text={data.summary.others} />

            <div className="flex items-center justify-between rounded-lg border bg-background px-4 py-2.5 text-sm">
              <span className="text-muted-foreground">{L.selfRating}</span>
              <span className="font-medium tabular-nums">{ratingText(data.selfRating)}</span>
            </div>

            {/* Plan-only day: the report (actuals, self-rating) does not exist yet, so there is nothing to rate. */}
            {!data.reportSubmitted ? (
              <p className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">{L.reportPending}</p>
            ) : <RmReviewPanel
              officerId={officerId}
              workDate={workDate}
              review={data.review}
              readOnly={readOnly}
              onReviewed={() => {
                qc.invalidateQueries({ queryKey: ["team-review", officerId, workDate] });
                qc.invalidateQueries({ queryKey: ["team-performance"] });
              }}
            />}
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>{L.close}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A titled block holding either a compact Planned | Actual table or a one-line empty state (never a big blank box). */
type SectionKey = "sales" | "recovery" | "appointment" | "scheme_conversion" | "visits" | "others";
function ReadSection({ title, section, empty, children }: { title: string; section: SectionKey; empty?: boolean; children?: React.ReactNode }) {
  // One editable empty-state label per section (Edit Labels → Daily Work Review).
  const noDataLabels = {
    sales: useLabel("daily_work.review.no_data_sales"), recovery: useLabel("daily_work.review.no_data_recovery"), appointment: useLabel("daily_work.review.no_data_appointment"),
    scheme_conversion: useLabel("daily_work.review.no_data_scheme_conversion"), visits: useLabel("daily_work.review.no_data_visits"), others: useLabel("daily_work.review.no_data_others"),
  };
  const noData = noDataLabels[section];
  return (
    <section data-review-section={title}>
      <h3 className="mb-1.5 text-sm font-semibold">{title}</h3>
      {empty ? <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">{noData}</p>
        : <div className="overflow-auto rounded-md border [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3">{children}</div>}
    </section>
  );
}

function useReviewColumns() {
  return {
    dealer: useLabel("col.dealer"),
    dealerClient: useLabel("daily_work.col.review_dealer_client"),
    task: useLabel("daily_work.col.task_type"),
    planned: useLabel("daily_work.col.review_planned"),
    actual: useLabel("daily_work.col.review_actual"),
    metric: useLabel("daily_work.col.review_metric"),
    item: useLabel("daily_work.col.review_item"),
    scheme: useLabel("daily_work.col.scheme"),
    market: useLabel("daily_work.col.market"),
    paymentMode: useLabel("daily_work.col.payment_mode"),
    recoveryType: useLabel("daily_work.col.recovery_type"),
    salesType: useLabel("daily_work.col.sales_type"),
    regular: useLabel("daily_work.type.regular"),
    schemeType: useLabel("daily_work.type.scheme"),
    auto: useLabel("daily_work.task_type.auto"),
    manual: useLabel("daily_work.task_type.manual"),
    calendar: useLabel("daily_work.task_type.calendar"),
    appointed: useLabel("daily_work.status.appointed"),
    notAppointed: useLabel("daily_work.status.not_appointed"),
    yes: useLabel("daily_work.achievability.yes"),
    no: useLabel("daily_work.achievability.no"),
    dealerVisits: useLabel("daily_work.visits.dealer_visits"),
    newPartyVisits: useLabel("daily_work.visits.new_party_visits"),
  };
}

const money = (v: number | null | undefined) => (v == null ? dash : formatCurrency(v));

/** Sales / Recovery: Planned = Today's Plan (Daily Plan); Actual = Today's Sales/Recovery (Daily Report) — separate columns. */
export function DealerSection({ title, rows, recovery = false, autoEntryIds = [], calendarEntryIds = [] }: {
  title: string; rows: DealerRow[]; recovery?: boolean; autoEntryIds?: string[]; calendarEntryIds?: string[];
}) {
  const C = useReviewColumns();
  const auto = new Set(autoEntryIds), calendar = new Set(calendarEntryIds);
  const taskText = (row: DealerRow) => {
    const type = rowTaskType(!!row.entryId && auto.has(row.entryId), !!row.entryId && calendar.has(row.entryId));
    return type === "AUTO" ? C.auto : type === "CALENDAR" ? C.calendar : C.manual;
  };
  const typeText = (row: DealerRow) => (row.entryType === "SCHEME" ? C.schemeType : C.regular);
  return (
    <ReadSection title={title} section={recovery ? "recovery" : "sales"} empty={rows.length === 0}>
      <Table>
        <TableHeader><TableRow>
          <TableHead>{C.dealer}</TableHead><TableHead>{C.task}</TableHead>
          <TableHead className="text-right">{C.planned}</TableHead><TableHead className="text-right">{C.actual}</TableHead>
          {recovery && <TableHead>{C.paymentMode}</TableHead>}
          {recovery && <TableHead>{C.recoveryType}</TableHead>}
        </TableRow></TableHeader>
        <DealerTableBody>
          {rows.map((r) => (
            <TableRow data-dealer-id={r.dealerId} key={r.entryId ?? r.dealerId}>
              <TableCell className="font-medium"><DealerName id={r.dealerId} name={r.dealerName} /></TableCell>
              <TableCell>{taskText(r)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.todaysPlan)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.todaysActual)}</TableCell>
              {/* Payment Mode is a Daily Report value: it sits with the Actual recovery, never with the plan. */}
              {recovery && <TableCell><RecoveryPaymentModeField value={r.paymentMode ?? null} /></TableCell>}
              {recovery && <TableCell>{typeText(r)}</TableCell>}
            </TableRow>
          ))}
        </DealerTableBody>
      </Table>
    </ReadSection>
  );
}

/** Dealer Appointment: Planned = the planned dealer/client visit (market); Actual = the reported result. */
export function AppointmentSection({ title, rows }: { title: string; rows: ApptRow[] }) {
  const C = useReviewColumns();
  const result = (status: string | null) => status === "APPOINTED" ? C.appointed : status === "NOT_APPOINTED" ? C.notAppointed : dash;
  return (
    <ReadSection title={title} section="appointment" empty={rows.length === 0}>
      <Table>
        <TableHeader><TableRow><TableHead>{C.dealerClient}</TableHead><TableHead>{C.planned}</TableHead><TableHead>{C.actual}</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.rowId}>
              <TableCell className="font-medium">{r.dealerName}</TableCell>
              <TableCell>{r.marketName ? `${C.market}: ${r.marketName}` : C.planned}</TableCell>
              <TableCell>{result(r.status)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ReadSection>
  );
}

/** Scheme Conversion: Planned = planned units for today; Actual = the reported achievability. */
export function ConversionSection({ title, rows }: { title: string; rows: ConvRow[] }) {
  const C = useReviewColumns();
  const result = (v: string | null) => v === "YES" ? C.yes : v === "NO" ? C.no : dash;
  return (
    <ReadSection title={title} section="scheme_conversion" empty={rows.length === 0}>
      <Table>
        <TableHeader><TableRow>
          <TableHead>{C.dealer}</TableHead><TableHead>{C.scheme}</TableHead>
          <TableHead className="text-right">{C.planned}</TableHead><TableHead>{C.actual}</TableHead>
        </TableRow></TableHeader>
        <DealerTableBody>
          {rows.map((r) => (
            <TableRow data-dealer-id={r.dealerId} key={`${r.dealerId}:${r.schemeId}`}>
              <TableCell className="font-medium"><DealerName id={r.dealerId} name={r.dealerName} /></TableCell>
              <TableCell>{r.schemeName}</TableCell>
              <TableCell className="text-right tabular-nums">{r.todaysPlan ?? 0}</TableCell>
              <TableCell>{result(r.achievability)}</TableCell>
            </TableRow>
          ))}
        </DealerTableBody>
      </Table>
    </ReadSection>
  );
}

/** Visits: Planned (Daily Plan counts) vs Actual (Daily Report counts), one metric per row. */
export function VisitsSection({ title, summary }: { title: string; summary: SummaryDto }) {
  const C = useReviewColumns();
  const count = (v: number | null | undefined) => (v == null ? dash : v);
  const metrics = [
    { label: C.dealerVisits, planned: summary.dealerVisits, actual: summary.actualDealerVisits },
    { label: C.newPartyVisits, planned: summary.newPartyVisits, actual: summary.actualNewPartyVisits },
  ];
  return (
    <ReadSection title={title} section="visits" empty={!summary.visitsEntered}>
      <Table>
        <TableHeader><TableRow><TableHead>{C.metric}</TableHead><TableHead className="text-right">{C.planned}</TableHead><TableHead className="text-right">{C.actual}</TableHead></TableRow></TableHeader>
        <TableBody>
          {metrics.map((m) => (
            <TableRow key={m.label}>
              <TableCell className="font-medium">{m.label}</TableCell>
              <TableCell className="text-right tabular-nums">{count(m.planned)}</TableCell>
              <TableCell className="text-right tabular-nums">{count(m.actual)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ReadSection>
  );
}

/** Others: the planned note. Daily Work records no separate actual for Others, so Actual stays "—" (nothing is invented). */
export function OthersSection({ title, text }: { title: string; text: string }) {
  const C = useReviewColumns();
  return (
    <ReadSection title={title} section="others" empty={text.trim() === ""}>
      <Table>
        <TableHeader><TableRow><TableHead>{C.item}</TableHead><TableHead>{C.planned}</TableHead><TableHead>{C.actual}</TableHead></TableRow></TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="font-medium">{title}</TableCell>
            <TableCell className="whitespace-pre-wrap">{text}</TableCell>
            <TableCell>{dash}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </ReadSection>
  );
}

/**
 * RM review area. When a review exists it is shown LOCKED (read-only, no edit/re-rate). Otherwise a 1–10
 * slider + numeric input (unset initially, kept in sync) with an explicit Submit. The server re-validates,
 * enforces authorization and immutability; this is the convenience gate.
 */
function RmReviewPanel({ officerId, workDate, review, onReviewed, readOnly = false }: {
  officerId: string; workDate: string; review: ReviewDto | null; onReviewed: () => void; readOnly?: boolean;
}) {
  const L = {
    rmReview: useLabel("daily_work.review.rm_review"),
    notRated: useLabel("daily_work.review.not_rated"),
    prompt: useLabel("daily_work.review.rate_prompt"),
    field: useLabel("daily_work.review.field"),
    placeholder: useLabel("daily_work.review.placeholder"),
    submit: useLabel("daily_work.review.submit"),
    submitting: useLabel("daily_work.state.submitting"),
    reviewer: useLabel("daily_work.review.reviewer"),
    reviewedAt: useLabel("daily_work.review.reviewed_at"),
    locked: useLabel("daily_work.review.locked"),
  };
  const [rating, setRating] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const valid = typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 10;

  const mut = useMutation({
    mutationFn: () => api.post<ReviewDto>("/api/daily-work/review", { officerId, workDate, rating }),
    onSuccess: () => { setError(null); onReviewed(); },
    onError: (e) => setError((e as Error).message),
  });

  if (review) {
    return (
      <div className="space-y-1.5 rounded-lg border border-success/40 bg-success/5 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">{L.rmReview}</span>
          <Badge variant="success"><Lock className="mr-1 h-3 w-3" />{L.locked}</Badge>
        </div>
        <div className="text-lg font-semibold tabular-nums">{ratingText(review.rating)}</div>
        <div className="text-muted-foreground">{L.reviewer}: {review.reviewerName}</div>
        <div className="text-muted-foreground">{L.reviewedAt}: {new Date(review.reviewedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
      </div>
    );
  }

  // Admin (read-only) with no review yet: observe "Not Rated"; never expose a rating control.
  if (readOnly) {
    return (
      <div className="flex items-center justify-between rounded-lg border bg-background px-4 py-2.5 text-sm">
        <span className="text-muted-foreground">{L.rmReview}</span>
        <span className="font-medium">{L.notRated}</span>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L.rmReview}</span>
        <span className="text-xs text-muted-foreground">{L.notRated}</span>
      </div>
      <p className="text-sm text-muted-foreground">{L.prompt}</p>
      <div className="text-center text-2xl font-semibold tabular-nums">
        {valid ? `${rating} / 10` : <span className="text-base font-normal text-muted-foreground">{L.placeholder}</span>}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">1</span>
        <input
          type="range" min={1} max={10} step={1}
          value={typeof rating === "number" ? rating : 1}
          onChange={(e) => { setRating(Number(e.target.value)); setError(null); }}
          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
          aria-label={L.field}
        />
        <span className="text-xs text-muted-foreground">10</span>
      </div>
      <div className="space-y-1.5">
        <Label>{L.field}</Label>
        <Input
          type="number" min={1} max={10} step={1} inputMode="numeric" className="w-24"
          placeholder={L.placeholder}
          value={rating === "" ? "" : String(rating)}
          onChange={(e) => { const v = e.target.value; if (v === "") { setRating(""); return; } const n = Number(v); setRating(Number.isFinite(n) ? n : ""); setError(null); }}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button disabled={!valid || mut.isPending} onClick={() => valid && mut.mutate()}>
        <Send className="h-4 w-4" /> {mut.isPending ? L.submitting : L.submit}
      </Button>
    </div>
  );
}
