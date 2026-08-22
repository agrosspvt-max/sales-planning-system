"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";
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
}

const PLAN_LABEL: Record<string, string> = { DRAFT: "Draft", SUBMITTED: "Submitted", RM_APPROVED: "RM Approved", RM_REJECTED: "RM Rejected", RETURNED: "Returned" };
const PLAN_VARIANT: Record<string, "secondary" | "default" | "success" | "destructive" | "muted"> = { DRAFT: "muted", SUBMITTED: "secondary", RM_APPROVED: "success", RM_REJECTED: "destructive", RETURNED: "default" };
const ENROLL_LABEL: Record<string, string> = { PENDING_DOCUMENT: "Pending Document", ENROLLED: "Enrolled" };
const DOC_LABEL: Record<string, string> = { SOFT_COPY: "Soft Copy", HARD_COPY: "Hard Copy" };
const dateTime = (s: string | null) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—");

export function PlanStatusBadge({ status }: { status: string }) {
  return <Badge variant={PLAN_VARIANT[status] ?? "muted"}>{PLAN_LABEL[status] ?? status}</Badge>;
}
export function EnrollStatusBadge({ status }: { status: string }) {
  return <Badge variant={status === "ENROLLED" ? "success" : "secondary"}>{ENROLL_LABEL[status] ?? status}</Badge>;
}

/**
 * Dealer-wise detail for one scheme (like Sales Planning → Dealer Plan, but rows are dealers). Clicking a
 * dealer opens a detail drawer with the planning + RM + enrollment history. When `canVerify` (Super Admin),
 * the drawer exposes the enrollment document verification form for RM-approved plans.
 */
export function SchemeDetailDialog({ schemeId, schemeName, canVerify = false, onClose }: { schemeId: string; schemeName: string; canVerify?: boolean; onClose: () => void }) {
  const { data, isLoading } = useQuery<SchemePlan[]>({ queryKey: ["scheme-plans", schemeId], queryFn: () => api.get(`/api/scheme-plans?schemeId=${schemeId}`) });
  const [selected, setSelected] = useState<SchemePlan | null>(null);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        {selected ? (
          <PlanDrawer plan={selected} canVerify={canVerify} onBack={() => setSelected(null)} onClose={onClose} />
        ) : (
          <>
            <DialogHeader><DialogTitle>{schemeName} — Dealer Plans</DialogTitle></DialogHeader>
            <div className="overflow-auto rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Dealer Name</TableHead>
                    <TableHead>Sales Officer</TableHead>
                    <TableHead>RM Status</TableHead>
                    <TableHead>Enrollment Status</TableHead>
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
                        <TableCell><PlanStatusBadge status={p.planningStatus} /></TableCell>
                        <TableCell><EnrollStatusBadge status={p.enrollmentStatus} /></TableCell>
                        <TableCell>{p.documentCompleted ? `Completed${p.documentType ? ` · ${DOC_LABEL[p.documentType]}` : ""}` : <span className="text-muted-foreground">Pending</span>}</TableCell>
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

/** Standalone single-plan detail + (admin) verify dialog, used from the Scheme Planning workspace. */
export function SchemePlanDialog({ plan, canVerify = false, onClose }: { plan: SchemePlan; canVerify?: boolean; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <PlanDrawer plan={plan} canVerify={canVerify} onBack={onClose} onClose={onClose} />
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

function PlanDrawer({ plan, canVerify, onBack, onClose }: { plan: SchemePlan; canVerify: boolean; onBack: () => void; onClose: () => void }) {
  const qc = useQueryClient();
  const [documentCompleted, setDocumentCompleted] = useState(plan.documentCompleted);
  const [documentType, setDocumentType] = useState(plan.documentType ?? "SOFT_COPY");
  const [remarks, setRemarks] = useState(plan.verificationRemarks ?? "");
  const [error, setError] = useState<string | null>(null);

  const verify = useMutation({
    mutationFn: () => api.post(`/api/scheme-plans/${plan.id}/verify`, { documentCompleted, documentType: documentCompleted ? documentType : null, remarks: remarks.trim() || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["scheme-plans"] }); onClose(); },
    onError: (e) => setError((e as Error).message),
  });

  const showVerify = canVerify && plan.planningStatus === "RM_APPROVED";

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
          <Row label="Planning Date" value={date(plan.createdAt)} />
          <Row label="Expected Billing Date" value={date(plan.expectedBillingDate)} />
          <Row label="Submitted" value={dateTime(plan.submittedAt)} />
        </section>
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">RM Approval History</h4>
          <Row label="Planning Status" value={<PlanStatusBadge status={plan.planningStatus} />} />
          <Row label="Actioned By" value={plan.rmActedByName ?? "—"} />
          <Row label="Actioned At" value={dateTime(plan.rmActedAt)} />
          {plan.rmRemarks && <Row label="RM Remarks" value={plan.rmRemarks} />}
        </section>
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Document Verification</h4>
          <Row label="Enrollment Status" value={<EnrollStatusBadge status={plan.enrollmentStatus} />} />
          <Row label="Document Completed" value={plan.documentCompleted ? "Yes" : "No"} />
          <Row label="Document Type" value={plan.documentType ? DOC_LABEL[plan.documentType] : "—"} />
          {plan.verificationRemarks && <Row label="Verification Remarks" value={plan.verificationRemarks} />}
          <Row label="Enrolled By" value={plan.enrolledByName ?? "—"} />
          <Row label="Enrolled At" value={dateTime(plan.enrolledAt)} />
        </section>

        {showVerify && (
          <section className="rounded-lg border bg-muted/30 p-3">
            <h4 className="mb-2 text-sm font-semibold">Verify Enrollment</h4>
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={documentCompleted} onChange={(e) => setDocumentCompleted(e.target.checked)} />
                Document Completed
              </label>
              {documentCompleted && (
                <div className="space-y-1.5">
                  <Label>Document Type *</Label>
                  <NativeSelect value={documentType} onChange={(e) => setDocumentType(e.target.value)} options={[{ value: "SOFT_COPY", label: "Soft Copy" }, { value: "HARD_COPY", label: "Hard Copy" }]} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Remarks</Label>
                <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" rows={2} />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <p className="text-xs text-muted-foreground">Confirming with a document marks the dealer as ENROLLED.</p>
            </div>
          </section>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onBack}>Back</Button>
        {showVerify && <Button disabled={verify.isPending} onClick={() => { setError(null); verify.mutate(); }}>{verify.isPending ? "Saving…" : documentCompleted ? "Confirm & Enroll" : "Save"}</Button>}
      </DialogFooter>
    </>
  );
}
