"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatDateShort } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface SchemePlan {
  id: string; schemeId: string; schemeName: string; dealerId: string; dealerName: string;
  salesOfficerId: string; salesOfficerName: string; state: string | null; territory: string | null;
  planningStatus: string; enrollmentStatus: string; expectedBillingDate: string | null; submittedAt: string | null;
  rmActedByName: string | null; rmActedAt: string | null; rmRemarks: string | null;
  documentCompleted: boolean; documentType: string | null; verificationRemarks: string | null;
  enrolledByName: string | null; enrolledAt: string | null; createdAt: string;
  // Part E
  planStatus: string; schemeStatus: string; numberOfSchemes: number; totalSchemeAmount: number; soNote: string | null; planningDate: string | null;
  originalConversionDate: string | null; conversionExtensionCount: number; maxExtensionDays: number; maxExtensionAttempts: number;
  conversionExtensions: { extensionNumber: number; previousConversionDate: string; newConversionDate: string; daysAdded: number; extendedByName: string | null; createdAt: string }[];
  conversionDate: string | null; soBookingStatus: string | null; soBookingAmount: number | null; soDocumentStatus: string | null; billingDate: string | null;
  adminConversionDate: string | null; adminBookingStatus: string | null; adminBookingAmount: number | null; adminDocumentStatus: string | null; adminBillingDate: string | null; adminVerifiedAt: string | null;
  soBillingSameForAll: boolean; adminBillingSameForAll: boolean;
  instances: { instanceNumber: number; soBillingDate: string | null; adminBillingDate: string | null }[];
}

// Part E Plan Status labels/badges.
export const PLAN_STATUS_LABEL: Record<string, string> = { DRAFT: "Draft", PENDING_RM: "Pending for RM", PENDING_APPROVAL: "Pending Approval", APPROVED: "Approved", RETURNED: "Returned", REJECTED: "Rejected" };
const PLAN_STATUS_VARIANT: Record<string, "secondary" | "default" | "success" | "destructive" | "muted"> = { DRAFT: "muted", PENDING_RM: "secondary", PENDING_APPROVAL: "default", APPROVED: "success", RETURNED: "default", REJECTED: "destructive" };
export function PlanStateBadge({ status }: { status: string }) {
  return <Badge variant={PLAN_STATUS_VARIANT[status] ?? "muted"}>{PLAN_STATUS_LABEL[status] ?? status}</Badge>;
}
// Scheme (conversion) status marker — driven by ADMIN verification only. Until the Admin verifies the
// booking/document, a Converted plan shows NO marker (SO entries never produce ✓/!/✕).
export function schemeStatusMark(p: { schemeStatus: string; adminBookingStatus: string | null; adminDocumentStatus: string | null }): "" | "✓" | "!" | "✕" | "?" {
  if (p.schemeStatus !== "CONVERTED") return "";
  if (p.adminBookingStatus == null && p.adminDocumentStatus == null) return ""; // not yet Admin-verified
  const bookingOk = p.adminBookingStatus === "RECEIVED";
  const bookingFail = p.adminBookingStatus === "NOT_RECEIVED";
  const docOk = p.adminDocumentStatus === "RECEIVED_SOFT" || p.adminDocumentStatus === "RECEIVED_HARD";
  const docFail = p.adminDocumentStatus === "NOT_RECEIVED";
  if (bookingOk && docOk) return "✓"; // fully confirmed
  if (bookingOk && docFail) return "?"; // special "Question-Mark Converted": Paid but document Not Received
  if (bookingFail || docFail) return "✕";
  return "!"; // partial / incomplete Admin verification
}
export function SchemeStatusBadge({ plan }: { plan: SchemePlan }) {
  const mark = schemeStatusMark(plan);
  const label = plan.schemeStatus === "CONVERTED" ? "Converted" : plan.schemeStatus === "DECLINED" ? "Declined" : "Pending";
  const variant = plan.schemeStatus === "DECLINED" ? "destructive" : mark === "✓" ? "success" : mark === "?" ? "warning" : mark === "✕" ? "destructive" : mark === "!" ? "default" : "secondary";
  return <Badge variant={variant}>{mark ? `${mark} ` : ""}{label}</Badge>;
}


/**
 * Dealer-wise detail for one scheme (like Sales Planning → Dealer Plan, but rows are dealers). Clicking a
 * dealer opens a read-only detail drawer (planning + approval + verification history). Admin verification
 * is performed from the Scheme Planning workspace, not here.
 */
export function SchemeDetailDialog({ schemeId, schemeName, onClose }: { schemeId: string; schemeName: string; canVerify?: boolean; onClose: () => void }) {
  const { data, isLoading } = useQuery<SchemePlan[]>({ queryKey: ["scheme-plans", schemeId], queryFn: () => api.get(`/api/scheme-plans?schemeId=${schemeId}`) });
  const [selected, setSelected] = useState<SchemePlan | null>(null);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        {selected ? (
          <PlanDrawer plan={selected} onBack={() => setSelected(null)} />
        ) : (
          <>
            <DialogHeader><DialogTitle>{schemeName} — Dealer Plans</DialogTitle></DialogHeader>
            <div className="overflow-auto rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Dealer Name</TableHead>
                    <TableHead>Sales Officer</TableHead>
                    <TableHead>Plan Status</TableHead>
                    <TableHead>Scheme Status</TableHead>
                    <TableHead>Document Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ) : (data?.length ?? 0) === 0 ? (
                    <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">No dealer plans for this scheme yet.</TableCell></TableRow>
                  ) : (
                    data!.map((p) => (
                      <TableRow key={p.id} className="cursor-pointer hover:bg-accent/40" onClick={() => setSelected(p)}>
                        <TableCell className="font-medium">{p.dealerName}</TableCell>
                        <TableCell>{p.salesOfficerName}</TableCell>
                        <TableCell><PlanStateBadge status={p.planStatus} /></TableCell>
                        <TableCell>{p.planStatus === "APPROVED" ? <SchemeStatusBadge plan={p} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell>{p.adminDocumentStatus ? ADMIN_DOC_LABEL[p.adminDocumentStatus] ?? p.adminDocumentStatus : p.soDocumentStatus ? SO_DOC_LABEL[p.soDocumentStatus] ?? p.soDocumentStatus : <span className="text-muted-foreground">—</span>}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Standalone read-only single-plan detail, used from Open in the Scheme Planning workspace.
 *  `canExtend` enables the Conversion Date Extension picker (owner Sales Officer only); `onExtended`
 *  is called after a successful extension so the host can refetch. */
export function SchemePlanDialog({ plan, onClose, canExtend = false, onExtended }: { plan: SchemePlan; canVerify?: boolean; canExtend?: boolean; onExtended?: () => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <PlanDrawer plan={plan} onBack={onClose} canExtend={canExtend} onExtended={onExtended} />
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

const SO_BOOKING_LABEL: Record<string, string> = { RECEIVED: "Paid", NOT_RECEIVED: "Not paid", PARTIAL: "Partially paid" };
const SO_DOC_LABEL: Record<string, string> = { SIGNED_BUT_NOT_SENT: "Signed but not sent", SIGNED_AND_SENT: "Soft copy sent", HARD_COPY_SENT: "Hard copy sent", DOC_RECEIVED: "HO received hard copy" };
const ADMIN_DOC_LABEL: Record<string, string> = { RECEIVED_SOFT: "Received Soft Copy", RECEIVED_HARD: "Received Hard Copy", NOT_RECEIVED: "Not Received" };
const money = (n: number | null) => (n == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n))}`);

/* ------------------- Shared conversion-detail display helpers -------------------
 * ONE place that decides, per field, the value + ✓/!/✕ marker shown in the tables. The Admin-final
 * value (admin* fields) is preferred once present; otherwise the SO value; otherwise "—". Markers reuse
 * the existing convention (✓ complete/verified, ! partial/intermediate, ✕ failed/not received). These
 * are DISPLAY-ONLY — they read existing fields and never change workflow, enrollment, or Scheme Status. */
export type SchemeMark = "" | "✓" | "!" | "✕";
export interface MarkedText { text: string; mark: SchemeMark }
const MARK_CLASS: Record<SchemeMark, string> = { "✓": "text-success", "!": "text-warning", "✕": "text-destructive", "": "" };

/* The ✓/!/✕ marker is an ADMIN VERIFICATION INDICATOR ONLY. An SO-entered value is shown with NO marker;
 * a marker appears only once the Admin has explicitly entered/overridden that field. */

/** Conversion Date — Admin value ⇒ ✓; otherwise the SO value with no marker. */
export function conversionDateCell(p: SchemePlan): MarkedText {
  if (p.adminConversionDate) return { text: formatDateShort(p.adminConversionDate), mark: "✓" };
  if (p.conversionDate) return { text: formatDateShort(p.conversionDate), mark: "" };
  return { text: "—", mark: "" };
}
/**
 * Per-record billing-date summary for one side (SO or Admin). Multi-scheme plans keep a billing date PER
 * instance; a same-for-all plan also carries one plan-level date. `filled`/`total` are counted per scheme
 * record (never collapsed to one dealer). Display-only: reads existing fields, changes no data.
 */
export function billingSide(p: SchemePlan, side: "so" | "admin"): { filled: number; total: number; dates: string[]; display: string } {
  const total = p.numberOfSchemes || 1;
  const instDates = p.instances
    .map((i) => (side === "so" ? i.soBillingDate : i.adminBillingDate))
    .filter((d): d is string => !!d);
  const parent = side === "so" ? p.billingDate : p.adminBillingDate;
  // Per-instance dates are the source of truth; fall back to the plan-level (same-for-all) date if the
  // instances carry none (e.g. legacy records) — one plan-level date then covers all applicable records.
  const dates = instDates.length ? instDates : parent ? [parent] : [];
  const filled = instDates.length ? instDates.length : parent ? total : 0;
  const distinct = new Set(dates.map((d) => d.slice(0, 10)));
  // Show the actual date only when it is genuinely ONE date across every applicable record; otherwise the
  // count ratio (so differing/partial dates are never hidden as blank).
  const display = filled === 0 ? "—" : total <= 1 || (filled === total && distinct.size === 1) ? formatDateShort(dates[0]) : `${filled}/${total}`;
  return { filled, total, dates, display };
}

/**
 * Billing Date value for the dealer tables. Admin side takes precedence (✓); otherwise the SO value (no
 * marker). Clickable — opens a breakdown of SO vs Admin filled counts and the actual dates.
 */
export function BillingDateValue({ plan }: { plan: SchemePlan }) {
  const admin = billingSide(plan, "admin");
  const so = billingSide(plan, "so");
  const cell: MarkedText = admin.filled > 0 ? { text: admin.display, mark: "✓" } : so.filled > 0 ? { text: so.display, mark: "" } : { text: "—", mark: "" };
  if (cell.text === "—") return <MarkedValue v={cell} />;
  const fmt = (ds: string[]) => (ds.length ? [...new Set(ds.map((d) => formatDateShort(d)))].join(", ") : "—");
  return (
    <details className="group relative inline-block text-left font-normal normal-case" onClick={(e) => e.stopPropagation()}>
      <summary className="cursor-pointer list-none hover:underline"><MarkedValue v={cell} /></summary>
      <div className="absolute left-0 z-30 mt-1 w-64 rounded-md border bg-background p-2 text-xs shadow-md">
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">Billing Dates</div>
        <div className="flex justify-between gap-3 py-0.5"><span className="text-muted-foreground">Total applicable records</span><span className="font-medium tabular-nums">{so.total}</span></div>
        <div className="mt-1 border-t pt-1">
          <div className="flex justify-between gap-3 py-0.5"><span className="text-muted-foreground">SO billing dates filled</span><span className="font-medium tabular-nums">{so.filled}/{so.total}</span></div>
          <div className="text-muted-foreground">{fmt(so.dates)}</div>
        </div>
        <div className="mt-1 border-t pt-1">
          <div className="flex justify-between gap-3 py-0.5"><span className="text-muted-foreground">Admin billing dates filled</span><span className="font-medium tabular-nums">{admin.filled}/{admin.total}</span></div>
          <div className="text-success">{fmt(admin.dates)}</div>
        </div>
      </div>
    </details>
  );
}
/** Booking Amount — Admin value ⇒ ✓ Received / ! Partial / ✕ Not Received; otherwise SO value, no marker. */
export function bookingCell(p: SchemePlan): MarkedText {
  if (p.adminBookingStatus) {
    const s = p.adminBookingStatus;
    const label = SO_BOOKING_LABEL[s] ?? s;
    const text = s !== "NOT_RECEIVED" && p.adminBookingAmount != null ? `${label} · ${money(p.adminBookingAmount)}` : label;
    const mark: SchemeMark = s === "RECEIVED" ? "✓" : s === "PARTIAL" ? "!" : "✕";
    return { text, mark };
  }
  if (p.soBookingStatus) {
    const s = p.soBookingStatus;
    const label = SO_BOOKING_LABEL[s] ?? s;
    const text = s !== "NOT_RECEIVED" && p.soBookingAmount != null ? `${label} · ${money(p.soBookingAmount)}` : label;
    return { text, mark: "" };
  }
  return { text: "—", mark: "" };
}
/** Document Status — Admin value ⇒ ✓ Received (soft/hard) / ✕ Not Received; otherwise SO value, no marker. */
export function documentCell(p: SchemePlan): MarkedText {
  if (p.adminDocumentStatus) {
    const s = p.adminDocumentStatus;
    return { text: ADMIN_DOC_LABEL[s] ?? s, mark: s === "NOT_RECEIVED" ? "✕" : "✓" };
  }
  if (p.soDocumentStatus) {
    const s = p.soDocumentStatus;
    return { text: SO_DOC_LABEL[s] ?? s, mark: "" };
  }
  return { text: "—", mark: "" };
}
/** Render a marked value (colored marker + text) consistently across tables. */
export function MarkedValue({ v }: { v: MarkedText }) {
  if (!v.mark) return <span>{v.text}</span>;
  return <span className="inline-flex items-center gap-1"><span className={cn("font-semibold", MARK_CLASS[v.mark])}>{v.mark}</span>{v.text}</span>;
}

/** Planned Conversion date = the CURRENT (possibly extended) conversion date. Turns yellow with a small grey
 *  count badge once the date has been extended; plain otherwise. Display-only. */
export function PlannedConversionCell({ plan }: { plan: SchemePlan }) {
  if (!plan.expectedBillingDate) return <span className="text-muted-foreground">—</span>;
  const count = plan.conversionExtensionCount ?? 0;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={cn("tabular-nums", count > 0 && "text-warning")}>{formatDateShort(plan.expectedBillingDate)}</span>
      {count > 0 && (
        <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium text-muted-foreground" title={`Extended ${count} time(s)`}>{count}</span>
      )}
    </span>
  );
}

/** Read-only plan detail (used from Open). Verification is a separate Admin dialog; this never edits the
 *  verification fields. The Conversion Date Extension section is the one editable affordance, gated by
 *  `canExtend` (owner Sales Officer within scope). */
function PlanDrawer({ plan, onBack, canExtend = false, onExtended }: { plan: SchemePlan; onBack: () => void; canExtend?: boolean; onExtended?: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button>
          {plan.dealerName}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scheme</h4>
          <Row label="Scheme" value={plan.schemeName} />
          <Row label="Sales Officer" value={plan.salesOfficerName} />
          <Row label="State" value={plan.state ?? "—"} />
          <Row label="Territory" value={plan.territory ?? "—"} />
          <Row label="Number of Schemes" value={plan.numberOfSchemes} />
          <Row label="Total Amount" value={money(plan.totalSchemeAmount)} />
          <Row label="Conversion Date" value={formatDateShort(plan.expectedBillingDate)} />
          <Row label="Planning Date" value={formatDateShort(plan.planningDate)} />
        </section>
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Approval</h4>
          <Row label="Plan Status" value={<PlanStateBadge status={plan.planStatus} />} />
          <Row label="Actioned By" value={plan.rmActedByName ?? "—"} />
          <Row label="Actioned At" value={formatDateShort(plan.rmActedAt)} />
          {plan.rmRemarks && <Row label="Remarks" value={plan.rmRemarks} />}
        </section>
        {plan.planStatus === "APPROVED" && (
          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scheme Status & Verification</h4>
            <Row label="Scheme Status" value={<SchemeStatusBadge plan={plan} />} />
            <Row label="Conversion Date" value={formatDateShort(plan.adminConversionDate ?? plan.conversionDate)} />
            <Row label="Booking (SO)" value={plan.soBookingStatus ? `${SO_BOOKING_LABEL[plan.soBookingStatus] ?? plan.soBookingStatus}${plan.soBookingAmount != null ? ` · ${money(plan.soBookingAmount)}` : ""}` : "—"} />
            <Row label="Booking (Admin)" value={plan.adminBookingStatus ? `${SO_BOOKING_LABEL[plan.adminBookingStatus] ?? plan.adminBookingStatus}${plan.adminBookingAmount != null ? ` · ${money(plan.adminBookingAmount)}` : ""}` : "—"} />
            <Row label="Document (SO)" value={plan.soDocumentStatus ? SO_DOC_LABEL[plan.soDocumentStatus] ?? plan.soDocumentStatus : "—"} />
            <Row label="Document (Admin)" value={plan.adminDocumentStatus ? ADMIN_DOC_LABEL[plan.adminDocumentStatus] ?? plan.adminDocumentStatus : "—"} />
            <Row label="Billing Date" value={formatDateShort(plan.adminBillingDate ?? plan.billingDate)} />
            <Row label="Verified At" value={formatDateShort(plan.adminVerifiedAt)} />
            <Row label="Enrolled" value={plan.enrollmentStatus === "ENROLLED" ? `Yes · ${formatDateShort(plan.enrolledAt)}` : "No"} />
          </section>
        )}
        {plan.soNote && (
          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Note</h4>
            <p className="whitespace-pre-wrap text-sm">{plan.soNote}</p>
          </section>
        )}
        <ConversionExtensionSection plan={plan} canExtend={canExtend} onExtended={onExtended} />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onBack}>Back</Button>
      </DialogFooter>
    </>
  );
}

/* ---- Conversion Date Extension (date-only math mirrors the server; UI only gates, server enforces) ---- */
const dayNum = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000); };
const addDaysInput = (iso: string, n: number) => new Date(dayNum(iso) * 86_400_000 + n * 86_400_000).toISOString().slice(0, 10);

/** Original / current dates, used vs remaining, full history, and (for the owning SO) an Extend picker
 *  bounded to Original + Max Days. Hidden entirely when a scheme has no extension config and no history. */
function ConversionExtensionSection({ plan, canExtend, onExtended }: { plan: SchemePlan; canExtend: boolean; onExtended?: () => void }) {
  const original = plan.originalConversionDate ?? plan.expectedBillingDate;
  const current = plan.expectedBillingDate;
  const maxDays = plan.maxExtensionDays ?? 0;
  const maxAttempts = plan.maxExtensionAttempts ?? 0;
  const extensions = plan.conversionExtensions ?? [];
  const configured = maxDays > 0 && maxAttempts > 0;
  const [newDate, setNewDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ext = useMutation({
    mutationFn: () => api.post(`/api/scheme-plans/${plan.id}/extend-conversion`, { newConversionDate: newDate }),
    onSuccess: () => { setNewDate(""); setError(null); onExtended?.(); },
    onError: (e) => setError((e as Error).message),
  });
  if ((!configured && extensions.length === 0) || !original || !current) return null;

  const daysUsed = dayNum(current) - dayNum(original);
  const remaining = Math.max(0, maxDays - daysUsed);
  const attemptsUsed = plan.conversionExtensionCount ?? extensions.length;
  const attemptsRemaining = Math.max(0, maxAttempts - attemptsUsed);
  const eligibleStatus = plan.schemeStatus !== "CONVERTED" && plan.adminVerifiedAt == null && ["PENDING_RM", "PENDING_APPROVAL", "APPROVED"].includes(plan.planStatus);
  const canPick = canExtend && configured && attemptsRemaining > 0 && remaining > 0 && eligibleStatus;
  const maxDate = addDaysInput(original, maxDays);
  const minDate = addDaysInput(current, 1);

  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Conversion Date Extension</h4>
      <Row label="Original Conversion Date" value={formatDateShort(original)} />
      <Row label="Current Conversion Date" value={formatDateShort(current)} />
      {configured && (
        <>
          <Row label="Extensions Used" value={`${attemptsUsed} / ${maxAttempts}`} />
          <Row label="Extension Days Used" value={`${daysUsed} / ${maxDays}`} />
          <Row label="Remaining Days" value={remaining} />
        </>
      )}
      {extensions.length > 0 && (
        <div className="mt-2 space-y-1.5 rounded-md border p-2 text-sm">
          <div className="text-muted-foreground">Original: <span className="font-medium text-foreground">{formatDateShort(original)}</span></div>
          {extensions.map((e) => (
            <div key={e.extensionNumber} className="border-t pt-1.5">
              <div className="font-medium">Extension {e.extensionNumber}</div>
              <div className="text-muted-foreground">{formatDateShort(e.previousConversionDate)} → {formatDateShort(e.newConversionDate)} · +{e.daysAdded} day{e.daysAdded === 1 ? "" : "s"}{e.extendedByName ? ` · by ${e.extendedByName}` : ""}</div>
            </div>
          ))}
          <div className="border-t pt-1.5 font-medium">Current Date: {formatDateShort(current)}</div>
        </div>
      )}
      {canPick && (
        <div className="mt-2 space-y-1.5">
          <Label>Extend Conversion Date</Label>
          <div className="flex items-center gap-2">
            <Input type="date" className="w-44" value={newDate} min={minDate} max={maxDate} onChange={(e) => setNewDate(e.target.value)} />
            <Button size="sm" disabled={!newDate || ext.isPending} onClick={() => { setError(null); ext.mutate(); }}>{ext.isPending ? "Saving…" : "Extend"}</Button>
          </div>
          <p className="text-xs text-muted-foreground">Latest allowed date: {formatDateShort(maxDate)} · {remaining} day(s) and {attemptsRemaining} attempt(s) remaining.</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      )}
    </section>
  );
}
