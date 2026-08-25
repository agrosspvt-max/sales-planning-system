"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { TransferRecoveryPlan } from "./transfer-dialog";
import type { PlanStatus } from "@/features/planning/types";

interface NoPlanDealer { dealerId: string; dealerName: string; noPlanReason: string | null; noPlanReasonDetail?: string | null }

/**
 * Recovery Plan workflow actions — same approval lifecycle as Monthly/Seasonal. Reviewers (RM on
 * Pending RM, Super Admin on Pending RM / Pending Super Admin) can Approve or Return-for-correction; a
 * Return requires a reason, sets status RETURNED (editable + resubmittable by the owner), records it in
 * the plan history and notifies the Sales Officer. The Super Admin Transfer tool is kept. The Approve
 * flow and all approval endpoints are unchanged.
 */
export function RecoveryActions({
  id, status, officerId, role, userId, remainingCount, totalDealers, noPlanDealers,
}: {
  id: string; status: PlanStatus; officerId: string; role: Role; userId: string;
  remainingCount: number; totalDealers: number; noPlanDealers: NoPlanDealer[];
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirmNoPlan, setConfirmNoPlan] = useState(false);
  // Return-for-correction modal (Super Admin / RM reviewer). Requires a reason, saved to audit + history.
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnReason, setReturnReason] = useState("");

  const base = `/api/recovery/plans/${id}`;
  // Owner = the officer the plan belongs to, whether a Sales Officer OR a Regional Manager who owns their
  // own plan (mirrors the backend isPlanOwner, which already permits an RM to submit their own plan).
  const isOwner = (role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER) && officerId === userId;
  const editable = status === "DRAFT" || status === "RETURNED" || status === "REJECTED";
  const canSubmit = totalDealers > 0 && remainingCount === 0;

  function refresh() {
    qc.invalidateQueries({ queryKey: ["recovery-plan", id] });
    qc.invalidateQueries({ queryKey: ["recovery-plans"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  }
  const act = useMutation({ mutationFn: (path: string) => api.post(`${base}/${path}`, {}), onSuccess: refresh, onError: (e) => setError((e as Error).message) });
  const doSubmit = () => { setConfirmNoPlan(false); act.mutate("submit"); };
  // Return sends the plan back to the owner for correction (reuses the existing /return endpoint, which
  // sets status RETURNED, records an ApprovalAction with the reason, and notifies the Sales Officer).
  const returnMut = useMutation({
    mutationFn: (reason: string) => api.post(`${base}/return`, { remarks: reason }),
    onSuccess: () => { setReturnOpen(false); setReturnReason(""); refresh(); },
    onError: (e) => setError((e as Error).message),
  });

  const buttons: React.ReactNode[] = [];
  if (isOwner && editable) {
    buttons.push(
      <Button key="submit" onClick={() => (noPlanDealers.length > 0 ? setConfirmNoPlan(true) : doSubmit())} disabled={act.isPending || !canSubmit} title={canSubmit ? undefined : `Account for every dealer first (${remainingCount} remaining).`}>
        Submit Recovery Plan
      </Button>,
    );
  }
  // Reviewer actions: Approve + Return (send back for correction).
  const isRm = role === Role.REGIONAL_MANAGER && status === "PENDING_RM";
  // Super Admin has final authority on ANY submitted plan — Pending RM or Pending Super Admin — so RM
  // approval is never a prerequisite for the admin to approve.
  const isAdmin = role === Role.SUPER_ADMIN && (status === "PENDING_ADMIN" || status === "PENDING_RM");
  if (isRm || isAdmin) {
    buttons.push(<Button key="approve" onClick={() => act.mutate("approve")} disabled={act.isPending || returnMut.isPending}>Approve</Button>);
    buttons.push(<Button key="return" variant="outline" onClick={() => { setError(null); setReturnOpen(true); }} disabled={act.isPending || returnMut.isPending}>Return</Button>);
  }
  // Super Admin can move this Recovery Plan to another Seasonal Plan version (self-contained dialog).
  const canTransfer = role === Role.SUPER_ADMIN;
  if (buttons.length === 0 && !error && !canTransfer) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {buttons}
      {canTransfer && <TransferRecoveryPlan id={id} />}
      {error && <span className="text-sm text-destructive">{error}</span>}

      <Dialog open={returnOpen} onOpenChange={(o) => { setReturnOpen(o); if (!o) setReturnReason(""); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Return recovery plan for correction</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="recovery-return-reason">Return reason *</Label>
            <Textarea id="recovery-return-reason" value={returnReason} onChange={(e) => setReturnReason(e.target.value)} placeholder="Explain what needs to be corrected before resubmission…" />
            <p className="text-xs text-muted-foreground">The Sales Officer is notified and can edit and resubmit. The reason is saved to the plan history.</p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturnOpen(false)} disabled={returnMut.isPending}>Cancel</Button>
            <Button onClick={() => returnMut.mutate(returnReason.trim())} disabled={returnMut.isPending || returnReason.trim().length === 0}>Return Plan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmNoPlan} onOpenChange={setConfirmNoPlan}>
        <DialogContent>
          <DialogHeader><DialogTitle>Submit with No-Plan dealers?</DialogTitle></DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">These dealers are marked No Plan and will be submitted as skipped:</p>
            <ul className="list-disc pl-5">{noPlanDealers.map((d) => <li key={d.dealerId}>{d.dealerName}{d.noPlanReason ? ` — ${d.noPlanReason}${d.noPlanReason === "Other" && d.noPlanReasonDetail ? ` (${d.noPlanReasonDetail})` : ""}` : ""}</li>)}</ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmNoPlan(false)}>Cancel</Button>
            <Button onClick={doSubmit} disabled={act.isPending}>Continue submit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
