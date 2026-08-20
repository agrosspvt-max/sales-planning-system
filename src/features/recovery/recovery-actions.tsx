"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TransferRecoveryPlan } from "./transfer-dialog";
import type { PlanStatus } from "@/features/planning/types";

interface NoPlanDealer { dealerId: string; dealerName: string; noPlanReason: string | null }

/**
 * Recovery Plan workflow actions — same approval lifecycle as Monthly/Seasonal. Approval screens are
 * VIEW-ONLY: once out of Draft the officer can no longer edit, resubmit or withdraw, and reviewers no
 * longer Return/Reject. Only Approve (RM/Admin) is retained so the lifecycle can progress; the Super
 * Admin Transfer tool is kept. Approval endpoints are unchanged.
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

  const base = `/api/recovery/plans/${id}`;
  const isOwner = role === Role.SALES_OFFICER && officerId === userId;
  const editable = status === "DRAFT" || status === "RETURNED" || status === "REJECTED";
  const canSubmit = totalDealers > 0 && remainingCount === 0;

  function refresh() {
    qc.invalidateQueries({ queryKey: ["recovery-plan", id] });
    qc.invalidateQueries({ queryKey: ["recovery-plans"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  }
  const act = useMutation({ mutationFn: (path: string) => api.post(`${base}/${path}`, {}), onSuccess: refresh, onError: (e) => setError((e as Error).message) });
  const doSubmit = () => { setConfirmNoPlan(false); act.mutate("submit"); };

  const buttons: React.ReactNode[] = [];
  if (isOwner && editable) {
    buttons.push(
      <Button key="submit" onClick={() => (noPlanDealers.length > 0 ? setConfirmNoPlan(true) : doSubmit())} disabled={act.isPending || !canSubmit} title={canSubmit ? undefined : `Account for every dealer first (${remainingCount} remaining).`}>
        Submit Recovery Plan
      </Button>,
    );
  }
  // Only reviewer action retained: Approve (view-only otherwise — no Return / Reject / Recall).
  const isRm = role === Role.REGIONAL_MANAGER && status === "PENDING_RM";
  // Super Admin has final authority on ANY submitted plan — Pending RM or Pending Super Admin — so RM
  // approval is never a prerequisite for the admin to approve.
  const isAdmin = role === Role.SUPER_ADMIN && (status === "PENDING_ADMIN" || status === "PENDING_RM");
  if (isRm || isAdmin) {
    buttons.push(<Button key="approve" onClick={() => act.mutate("approve")} disabled={act.isPending}>Approve</Button>);
  }
  // Super Admin can move this Recovery Plan to another Seasonal Plan version (self-contained dialog).
  const canTransfer = role === Role.SUPER_ADMIN;
  if (buttons.length === 0 && !error && !canTransfer) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {buttons}
      {canTransfer && <TransferRecoveryPlan id={id} />}
      {error && <span className="text-sm text-destructive">{error}</span>}

      <Dialog open={confirmNoPlan} onOpenChange={setConfirmNoPlan}>
        <DialogContent>
          <DialogHeader><DialogTitle>Submit with No-Plan dealers?</DialogTitle></DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">These dealers are marked No Plan and will be submitted as skipped:</p>
            <ul className="list-disc pl-5">{noPlanDealers.map((d) => <li key={d.dealerId}>{d.dealerName}{d.noPlanReason ? ` — ${d.noPlanReason}` : ""}</li>)}</ul>
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
