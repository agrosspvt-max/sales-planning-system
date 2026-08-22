"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus, Check, X, CornerUpLeft, Send, Eye, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PlanStatusBadge, EnrollStatusBadge, SchemePlanDialog, type SchemePlan } from "./scheme-detail-dialog";
import { SchemeOfficerWorkspace } from "./scheme-officer-workspace";

interface Opt { id: string; name: string }
interface EligibleScheme { id: string; schemeName: string }

/**
 * Scheme Planning entry — role-aware. Sales Officers use the field-sales workflow (Running Schemes /
 * My Schemes with drafts); Regional Managers approve/reject/return their team's plans (planning approval
 * only); Super Admin verifies enrollment documents and enrolls dealers.
 */
export function SchemePlanningPage({ role, userId }: { role: Role; userId: string }) {
  if (role === Role.SALES_OFFICER) return <SchemeOfficerWorkspace />;
  return <SchemeReviewWorkspace role={role} userId={userId} />;
}

/** RM/Admin review table: approve/reject/return (RM) and enrollment verification (Admin). */
function SchemeReviewWorkspace({ role, userId }: { role: Role; userId: string }) {
  const qc = useQueryClient();
  const isOfficer = role === Role.SALES_OFFICER;
  const isManager = role === Role.REGIONAL_MANAGER;
  const isAdmin = role === Role.SUPER_ADMIN;
  const canCreate = isManager; // Sales Officers create via the dedicated workspace

  const { data: rows, isLoading } = useQuery<SchemePlan[]>({ queryKey: ["scheme-plans", "all"], queryFn: () => api.get("/api/scheme-plans") });
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<SchemePlan | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["scheme-plans"] });

  const submit = useMutation({ mutationFn: (id: string) => api.post(`/api/scheme-plans/${id}/submit`, {}), onSuccess: invalidate, onError: (e) => alert((e as Error).message) });
  const act = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject" | "return"; remarks?: string }) => api.post(`/api/scheme-plans/${v.id}/act`, { action: v.action, remarks: v.remarks }),
    onSuccess: invalidate,
    onError: (e) => alert((e as Error).message),
  });
  const actWithRemarks = (id: string, action: "reject" | "return") => {
    const remarks = window.prompt(`Optional remarks for ${action}:`) ?? undefined;
    act.mutate({ id, action, remarks });
  };

  const canSubmit = (r: SchemePlan) => r.salesOfficerId === userId && (r.planningStatus === "DRAFT" || r.planningStatus === "RETURNED");
  const canRmAct = (r: SchemePlan) => isManager && r.salesOfficerId !== userId && r.planningStatus === "SUBMITTED";
  const canVerify = (r: SchemePlan) => isAdmin && r.planningStatus === "RM_APPROVED";

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Scheme Planning" }]}
        title="Scheme Planning"
        subtitle={isOfficer ? "Plan your assigned dealers into eligible schemes and submit for approval." : isManager ? "Approve, reject or return your team's scheme plans." : "Verify enrollment documents and enroll dealers."}
        actions={canCreate ? <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Create New Plan</Button> : undefined}
      />

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Scheme</TableHead>
              <TableHead>Dealer</TableHead>
              <TableHead>Sales Officer</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Planning Status</TableHead>
              <TableHead>Enrollment Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (rows?.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No scheme plans yet.</TableCell></TableRow>
            ) : (
              rows!.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.schemeName}</TableCell>
                  <TableCell>{r.dealerName}</TableCell>
                  <TableCell>{r.salesOfficerName}</TableCell>
                  <TableCell>{r.state ? <Badge variant="secondary">{r.state}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell><PlanStatusBadge status={r.planningStatus} /></TableCell>
                  <TableCell><EnrollStatusBadge status={r.enrollmentStatus} /></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {canSubmit(r) && <Button size="sm" variant="outline" disabled={submit.isPending} onClick={() => submit.mutate(r.id)}><Send className="h-4 w-4" /> Submit</Button>}
                      {canRmAct(r) && (
                        <>
                          <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: "approve" })}><Check className="h-4 w-4" /> Approve</Button>
                          <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => actWithRemarks(r.id, "return")}><CornerUpLeft className="h-4 w-4" /> Return</Button>
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={act.isPending} onClick={() => actWithRemarks(r.id, "reject")}><X className="h-4 w-4" /> Reject</Button>
                        </>
                      )}
                      {canVerify(r) && <Button size="sm" variant="outline" onClick={() => setDetail(r)}><ShieldCheck className="h-4 w-4" /> Verify</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setDetail(r)}><Eye className="h-4 w-4" /> Open</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {createOpen && <CreatePlanDialog onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); invalidate(); }} />}
      {detail && <SchemePlanDialog plan={detail} canVerify={isAdmin} onClose={() => setDetail(null)} />}
    </div>
  );
}

function CreatePlanDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { data: schemes } = useQuery<EligibleScheme[]>({ queryKey: ["eligible-schemes"], queryFn: () => api.get("/api/schemes/eligible") });
  const [schemeId, setSchemeId] = useState("");
  const [dealerId, setDealerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: dealers } = useQuery<Opt[]>({
    queryKey: ["scheme-dealers", schemeId],
    queryFn: () => api.get(`/api/schemes/${schemeId}/dealers`),
    enabled: !!schemeId,
  });

  const create = useMutation({
    mutationFn: () => api.post("/api/scheme-plans", { schemeId, dealerId }),
    onSuccess: onCreated,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create Scheme Plan</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Scheme *</Label>
            <NativeSelect placeholder="Select an eligible scheme…" options={(schemes ?? []).map((s) => ({ value: s.id, label: s.schemeName }))} value={schemeId} onChange={(e) => { setSchemeId(e.target.value); setDealerId(""); }} />
            {(schemes?.length ?? 0) === 0 && <p className="text-xs text-muted-foreground">No open schemes are applicable to your State.</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Dealer *</Label>
            <NativeSelect placeholder="Select a dealer…" disabled={!schemeId} options={(dealers ?? []).map((d) => ({ value: d.id, label: d.name }))} value={dealerId} onChange={(e) => setDealerId(e.target.value)} />
            {schemeId && (dealers?.length ?? 0) === 0 && <p className="text-xs text-muted-foreground">All your assigned dealers are already planned into this scheme.</p>}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!schemeId || !dealerId || create.isPending} onClick={() => { setError(null); create.mutate(); }}>{create.isPending ? "Saving…" : "Create Plan"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
