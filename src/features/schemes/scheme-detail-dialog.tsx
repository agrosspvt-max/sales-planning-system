"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  planStatus: string; schemeStatus: string; numberOfSchemes: number; totalSchemeAmount: number; planningDate: string | null;
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
export function schemeStatusMark(p: { schemeStatus: string; adminBookingStatus: string | null; adminDocumentStatus: string | null }): "" | "✓" | "!" | "✕" {
  if (p.schemeStatus !== "CONVERTED") return "";
  if (p.adminBookingStatus == null && p.adminDocumentStatus == null) return ""; // not yet Admin-verified
  const bookingOk = p.adminBookingStatus === "RECEIVED";
  const bookingFail = p.adminBookingStatus === "NOT_RECEIVED";
  const docOk = p.adminDocumentStatus === "RECEIVED_SOFT" || p.adminDocumentStatus === "RECEIVED_HARD";
  const docFail = p.adminDocumentStatus === "NOT_RECEIVED";
  if (bookingOk && docOk) return "✓";
  if (bookingFail || docFail) return "✕";
  return "!"; // partial / incomplete Admin verification
}
export function SchemeStatusBadge({ plan }: { plan: SchemePlan }) {
  const mark = schemeStatusMark(plan);
  const label = plan.schemeStatus === "CONVERTED" ? "Converted" : plan.schemeStatus === "DECLINED" ? "Declined" : "Pending";
  const variant = plan.schemeStatus === "DECLINED" ? "destructive" : mark === "✓" ? "success" : mark === "✕" ? "destructive" : mark === "!" ? "default" : "secondary";
  return <Badge variant={variant}>{mark ? `${mark} ` : ""}{label}</Badge>;
}

const dateTime = (s: string | null) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—");

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

/** Standalone read-only single-plan detail, used from Open in the Scheme Planning workspace. */
export function SchemePlanDialog({ plan, onClose }: { plan: SchemePlan; canVerify?: boolean; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <PlanDrawer plan={plan} onBack={onClose} />
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

const SO_BOOKING_LABEL: Record<string, string> = { RECEIVED: "Received", NOT_RECEIVED: "Not Received", PARTIAL: "Partial Received" };
const SO_DOC_LABEL: Record<string, string> = { SIGNED_BUT_NOT_SENT: "Signed but not Sent", SIGNED_AND_SENT: "Signed & Sent", DOC_RECEIVED: "Doc Received" };
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
  if (p.adminConversionDate) return { text: date(p.adminConversionDate), mark: "✓" };
  if (p.conversionDate) return { text: date(p.conversionDate), mark: "" };
  return { text: "—", mark: "" };
}
/** Billing Date — Admin value ⇒ ✓; otherwise the SO value with no marker. */
export function billingDateCell(p: SchemePlan): MarkedText {
  if (p.adminBillingDate) return { text: date(p.adminBillingDate), mark: "✓" };
  if (p.billingDate) return { text: date(p.billingDate), mark: "" };
  return { text: "—", mark: "" };
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

/** Read-only plan detail (used from Open). Verification is a separate Admin dialog; this never edits. */
function PlanDrawer({ plan, onBack }: { plan: SchemePlan; onBack: () => void }) {
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
          <Row label="Conversion Date" value={date(plan.expectedBillingDate)} />
          <Row label="Planning Date" value={dateTime(plan.planningDate)} />
        </section>
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Approval</h4>
          <Row label="Plan Status" value={<PlanStateBadge status={plan.planStatus} />} />
          <Row label="Actioned By" value={plan.rmActedByName ?? "—"} />
          <Row label="Actioned At" value={dateTime(plan.rmActedAt)} />
          {plan.rmRemarks && <Row label="Remarks" value={plan.rmRemarks} />}
        </section>
        {plan.planStatus === "APPROVED" && (
          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scheme Status & Verification</h4>
            <Row label="Scheme Status" value={<SchemeStatusBadge plan={plan} />} />
            <Row label="Conversion Date" value={date(plan.adminConversionDate ?? plan.conversionDate)} />
            <Row label="Booking (SO)" value={plan.soBookingStatus ? `${SO_BOOKING_LABEL[plan.soBookingStatus] ?? plan.soBookingStatus}${plan.soBookingAmount != null ? ` · ${money(plan.soBookingAmount)}` : ""}` : "—"} />
            <Row label="Booking (Admin)" value={plan.adminBookingStatus ? `${SO_BOOKING_LABEL[plan.adminBookingStatus] ?? plan.adminBookingStatus}${plan.adminBookingAmount != null ? ` · ${money(plan.adminBookingAmount)}` : ""}` : "—"} />
            <Row label="Document (SO)" value={plan.soDocumentStatus ? SO_DOC_LABEL[plan.soDocumentStatus] ?? plan.soDocumentStatus : "—"} />
            <Row label="Document (Admin)" value={plan.adminDocumentStatus ? ADMIN_DOC_LABEL[plan.adminDocumentStatus] ?? plan.adminDocumentStatus : "—"} />
            <Row label="Billing Date" value={date(plan.adminBillingDate ?? plan.billingDate)} />
            <Row label="Verified At" value={dateTime(plan.adminVerifiedAt)} />
            <Row label="Enrolled" value={plan.enrollmentStatus === "ENROLLED" ? `Yes · ${dateTime(plan.enrolledAt)}` : "No"} />
          </section>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onBack}>Back</Button>
      </DialogFooter>
    </>
  );
}
