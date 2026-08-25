"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api-client";
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
}

// Part E Plan Status labels/badges.
export const PLAN_STATUS_LABEL: Record<string, string> = { DRAFT: "Draft", PENDING_RM: "Pending for RM", PENDING_APPROVAL: "Pending Approval", APPROVED: "Approved", RETURNED: "Returned", REJECTED: "Rejected" };
const PLAN_STATUS_VARIANT: Record<string, "secondary" | "default" | "success" | "destructive" | "muted"> = { DRAFT: "muted", PENDING_RM: "secondary", PENDING_APPROVAL: "default", APPROVED: "success", RETURNED: "default", REJECTED: "destructive" };
export function PlanStateBadge({ status }: { status: string }) {
  return <Badge variant={PLAN_STATUS_VARIANT[status] ?? "muted"}>{PLAN_STATUS_LABEL[status] ?? status}</Badge>;
}
// Scheme (conversion) status with ✓/!/✕ markers derived from booking + document completeness.
export function schemeStatusMark(p: { schemeStatus: string; adminBookingStatus: string | null; soBookingStatus: string | null; adminDocumentStatus: string | null; soDocumentStatus: string | null }): "" | "✓" | "!" | "✕" {
  if (p.schemeStatus !== "CONVERTED") return "";
  const booking = p.adminBookingStatus ?? p.soBookingStatus;
  const doc = p.adminDocumentStatus ?? (p.soDocumentStatus === "RECEIVED" ? "RECEIVED_SOFT" : p.soDocumentStatus === "NOT_RECEIVED" ? "NOT_RECEIVED" : null);
  const bookingOk = booking === "RECEIVED";
  const bookingFail = booking === "NOT_RECEIVED" || booking == null;
  const docOk = doc === "RECEIVED_SOFT" || doc === "RECEIVED_HARD";
  const docFail = doc === "NOT_RECEIVED" || doc == null;
  if (bookingOk && docOk) return "✓";
  if (bookingFail || docFail) return "✕";
  return "!"; // partial
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

const SO_BOOKING_LABEL: Record<string, string> = { RECEIVED: "Received", NOT_RECEIVED: "Not Received", PARTIAL: "Partial" };
const SO_DOC_LABEL: Record<string, string> = { IN_TRANSIT: "In Transit", RECEIVED: "Received", NOT_RECEIVED: "Not Received" };
const ADMIN_DOC_LABEL: Record<string, string> = { RECEIVED_SOFT: "Received Soft Copy", RECEIVED_HARD: "Received Hard Copy", NOT_RECEIVED: "Not Received" };
const money = (n: number | null) => (n == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n))}`);

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
