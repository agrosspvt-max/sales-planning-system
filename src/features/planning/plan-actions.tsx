"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { detailDealerHasQty } from "./dealer-completion";
import type { PlanDetail } from "./types";

interface Props {
  detail: PlanDetail;
  role: Role;
  userId: string;
}

/**
 * Plan workflow actions. Approval screens are VIEW-ONLY: once a plan leaves Draft (Submitted / Pending RM
 * / Pending Admin / Approved) the officer can no longer edit, resubmit or withdraw it, and reviewers no
 * longer Return/Reject/Edit. The only forward action retained is Approve (RM on PENDING_RM, Admin on
 * PENDING_ADMIN) so the approval lifecycle can still progress. Draft/Returned/Rejected stay editable and
 * can be Submitted by the owning officer (unchanged workflow). Underlying approval endpoints are intact.
 */
export function PlanActions({ detail, role, userId }: Props) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirmNoPlan, setConfirmNoPlan] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnReason, setReturnReason] = useState("");

  const isOwner = role === Role.SALES_OFFICER && detail.officerId === userId;
  const base = `/api/planning/season-plans/${detail.id}`;

  // Dealer completion gate — every dealer must be Completed (≥1 saved qty) or No Plan.
  const remainingDealers = detail.dealers.filter((d) => !d.noPlan && !detailDealerHasQty(d));
  const noPlanDealers = detail.dealers.filter((d) => d.noPlan);
  const canSubmit = detail.dealers.length > 0 && remainingDealers.length === 0;
  const doSubmit = () => {
    setConfirmNoPlan(false);
    act.mutate("submit");
  };

  function refresh() {
    qc.invalidateQueries({ queryKey: ["plan", detail.id] });
    qc.invalidateQueries({ queryKey: ["plans"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  }

  const act = useMutation({
    mutationFn: (path: string) => api.post(`${base}/${path}`, {}),
    onSuccess: refresh,
    onError: (e) => setError((e as Error).message),
  });

  // Return-to-officer with a mandatory reason (Super Admin, on PENDING_ADMIN). RM flow is unchanged.
  const returnMut = useMutation({
    mutationFn: () => api.post(`${base}/return`, { remarks: returnReason.trim() }),
    onSuccess: () => { setReturnOpen(false); setReturnReason(""); refresh(); },
    onError: (e) => setError((e as Error).message),
  });

  const buttons: React.ReactNode[] = [];

  // Owner may Submit only while the plan is still editable (Draft / Returned / Rejected).
  if (isOwner && detail.canEdit) {
    buttons.push(
      <Button
        key="submit"
        onClick={() => (noPlanDealers.length > 0 ? setConfirmNoPlan(true) : doSubmit())}
        disabled={act.isPending || !canSubmit}
        title={canSubmit ? undefined : `Account for every dealer first (${remainingDealers.length} remaining).`}
      >
        Submit for approval
      </Button>,
    );
  }

  // Reviewer actions: RM approves PENDING_RM (unchanged). Super Admin has full override authority and may
  // approve/return from EITHER Pending RM or Pending Super Admin — approving a Pending-RM plan finalizes it
  // directly (RM step skipped). This is an additional admin path; the RM/Officer workflow is untouched.
  const isRmApprover = role === Role.REGIONAL_MANAGER && detail.status === "PENDING_RM";
  const isAdminApprover = role === Role.SUPER_ADMIN && (detail.status === "PENDING_ADMIN" || detail.status === "PENDING_RM");
  if (isRmApprover || isAdminApprover) {
    buttons.push(
      <Button key="approve" onClick={() => act.mutate("approve")} disabled={act.isPending}>
        Approve
      </Button>,
    );
  }
  if (isAdminApprover) {
    buttons.push(
      <Button key="return" variant="outline" onClick={() => { setError(null); setReturnOpen(true); }} disabled={act.isPending}>
        Return
      </Button>,
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {buttons}
      {error && <span className="text-sm text-destructive">{error}</span>}

      {/* Confirm before submitting when some dealers are intentionally skipped. */}
      <Dialog open={confirmNoPlan} onOpenChange={setConfirmNoPlan}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit with No-Plan dealers?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">The following dealers are marked as No Plan and will be submitted as skipped:</p>
            <ul className="list-disc pl-5">
              {noPlanDealers.map((d) => (
                <li key={d.dealerId}>
                  {d.dealerName}
                  {d.noPlanReason ? ` — ${d.noPlanReason}` : ""}
                </li>
              ))}
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmNoPlan(false)}>Cancel</Button>
            <Button onClick={doSubmit} disabled={act.isPending}>Continue submit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin return-to-officer with a mandatory reason. */}
      <Dialog open={returnOpen} onOpenChange={(o) => { setReturnOpen(o); if (!o) setReturnReason(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Return plan to Sales Officer</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Return reason *</Label>
            <Textarea
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
              placeholder="Explain what the Sales Officer needs to correct before resubmitting."
              rows={4}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">The officer will see this reason and can edit and resubmit the plan.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturnOpen(false)}>Cancel</Button>
            <Button onClick={() => { setError(null); returnMut.mutate(); }} disabled={!returnReason.trim() || returnMut.isPending}>
              {returnMut.isPending ? "Returning…" : "Return plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
