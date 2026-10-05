"use client";

import { DealerOrder } from "@/features/dealers/dealer-table-ui";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Send, Lock } from "lucide-react";
import { api } from "@/lib/api-client";
import { RecoveryPaymentModeField } from "./recovery-payment-mode";
import { type RecoveryPaymentMode, currentBusinessDate } from "@/lib/daily-work";
import { formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  reportSubmittedAt: string | null; selfRating: number | null; rmRating: number | null;
}
interface TeamSummary {
  salesOfficers: number; totalDays: number; submittedReports: number;
  averageSelfRating: number | null; averageRmRating: number | null;
}
interface TeamPayload { from: string; to: string; summary: TeamSummary; rows: TeamRow[] }

interface ReviewDto { rating: number; reviewerId: string; reviewerName: string; reviewedAt: string }
interface DealerRow { dealerId: string; dealerName: string; todaysPlan: number | null; todaysActual: number | null; paymentMode?: RecoveryPaymentMode | null }
interface ApptRow { rowId: string; dealerName: string; marketName: string; status: string | null }
interface ConvRow { dealerId: string; schemeId: string; dealerName: string; schemeName: string; todaysPlan: number | null; achievability: string | null }
interface SummaryDto { dealerVisits: number; newPartyVisits: number; others: string; visitsEntered: boolean }
interface ReviewDetail {
  officerId: string; officerName: string; workDate: string;
  sales: { dealers: DealerRow[] }; recovery: { dealers: DealerRow[] };
  appointment: { rows: ApptRow[] }; conversion: { rows: ConvRow[] };
  summary: SummaryDto; selfRating: number | null; review: ReviewDto | null;
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
        <div className="space-y-1.5"><Label>{L.dateFrom}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value || currentBusinessDate())} className="w-44" /></div>
        <div className="space-y-1.5"><Label>{L.dateTo}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value || currentBusinessDate())} className="w-44" /></div>
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
                    {r.reportSubmittedAt ? (
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
    close: useLabel("daily_work.action.cancel"),
  };
  const { data, isLoading, error } = useQuery<ReviewDetail>({
    queryKey: ["team-review", officerId, workDate],
    queryFn: () => api.get<ReviewDetail>(`/api/daily-work/review?officerId=${officerId}&date=${workDate}`),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{L.title}{data ? ` — ${data.officerName}` : ""}</DialogTitle>
        </DialogHeader>
        {isLoading ? <Skeleton className="h-64 w-full" /> : error || !data ? (
          <p className="text-sm text-destructive">{(error as Error | null)?.message ?? "Unavailable."}</p>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-muted-foreground">{data.officerName} · {workDate}</p>

            <DealerSection title={L.sales} rows={data.sales.dealers} />
            <DealerSection title={L.recovery} rows={data.recovery.dealers} recovery />

            <ReadSection title={L.appointment}>
              {data.appointment.rows.length === 0 ? dash : (
                <ul className="space-y-1 text-sm">
                  {data.appointment.rows.map((r) => (
                    <li key={r.rowId} className="flex justify-between gap-2">
                      <span>{r.dealerName}{r.marketName ? ` · ${r.marketName}` : ""}</span>
                      <span className="text-muted-foreground">{r.status ?? "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </ReadSection>

            <ReadSection title={L.conversion}>
              {data.conversion.rows.length === 0 ? dash : (
                <ul className="space-y-1 text-sm"><DealerOrder>
                  {data.conversion.rows.map((r) => (
                    <li data-dealer-id={r.dealerId} key={`${r.dealerId}:${r.schemeId}`} className="flex justify-between gap-2">
                      <span><DealerName id={r.dealerId} name={r.dealerName} /> · {r.schemeName}</span>
                      <span className="text-muted-foreground">{r.todaysPlan ?? 0} · {r.achievability ?? "—"}</span>
                    </li>
                  ))}
                </DealerOrder></ul>
              )}
            </ReadSection>

            <ReadSection title={`${L.visits} / ${L.others}`}>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between gap-2"><span>{L.visits}</span><span className="text-muted-foreground tabular-nums">{data.summary.visitsEntered ? `${data.summary.dealerVisits} · ${data.summary.newPartyVisits}` : "—"}</span></div>
                {data.summary.others.trim() !== "" && <div className="text-muted-foreground">{data.summary.others}</div>}
              </div>
            </ReadSection>

            <div className="flex items-center justify-between rounded-lg border bg-background px-4 py-2.5 text-sm">
              <span className="text-muted-foreground">{L.selfRating}</span>
              <span className="font-medium tabular-nums">{ratingText(data.selfRating)}</span>
            </div>

            <RmReviewPanel
              officerId={officerId}
              workDate={workDate}
              review={data.review}
              readOnly={readOnly}
              onReviewed={() => {
                qc.invalidateQueries({ queryKey: ["team-review", officerId, workDate] });
                qc.invalidateQueries({ queryKey: ["team-performance"] });
              }}
            />
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>{L.close}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReadSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-sm font-semibold">{title}</h3>
      <div className="rounded border px-3 py-2">{children}</div>
    </div>
  );
}

function DealerSection({ title, rows, recovery = false }: { title: string; rows: DealerRow[]; recovery?: boolean }) {
  return (
    <ReadSection title={title}>
      {rows.length === 0 ? dash : (
        <ul className="space-y-1 text-sm"><DealerOrder>
          {rows.map((r) => (
            <li data-dealer-id={r.dealerId} key={r.dealerId} className="flex justify-between gap-2">
              <span><DealerName id={r.dealerId} name={r.dealerName} /></span>
              <span className="text-muted-foreground tabular-nums">
                {r.todaysPlan == null ? "—" : formatCurrency(r.todaysPlan)}
                {recovery && <> · <RecoveryPaymentModeField value={r.paymentMode ?? null} /></>}
                {r.todaysActual != null ? ` · ${formatCurrency(r.todaysActual)}` : ""}
              </span>
            </li>
          ))}
        </DealerOrder></ul>
      )}
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
