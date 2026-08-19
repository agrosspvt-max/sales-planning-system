"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
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
import type { PlanStatus } from "./types";

/**
 * Monthly Plan workflow actions — the monthly analogue of PlanActions. Approval screens are VIEW-ONLY:
 * a plan that has left Draft can no longer be edited, resubmitted or withdrawn, and reviewers no longer
 * Return/Reject. Only Approve (RM/Admin) is retained so the lifecycle can progress. Draft/Returned/
 * Rejected remain editable and Submittable by the owning officer. Approval endpoints are unchanged.
 */
interface NoPlanDealer {
  dealerId: string;
  dealerName: string;
  noPlanReason: string | null;
}

export function MonthlyPlanActions({
  monthlyPlanId,
  status,
  officerId,
  role,
  userId,
  remainingCount = 0,
  totalDealers = 0,
  noPlanDealers = [],
}: {
  monthlyPlanId: string;
  status: PlanStatus;
  officerId: string;
  role: Role;
  userId: string;
  remainingCount?: number;
  totalDealers?: number;
  noPlanDealers?: NoPlanDealer[];
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirmNoPlan, setConfirmNoPlan] = useState(false);

  const base = `/api/planning/monthly-plans/${monthlyPlanId}`;
  const isOwner = role === Role.SALES_OFFICER && officerId === userId;

  function refresh() {
    qc.invalidateQueries({ queryKey: ["monthly-plan", monthlyPlanId] });
    qc.invalidateQueries({ queryKey: ["monthly-plans"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  }

  const act = useMutation({
    mutationFn: (path: string) => api.post(`${base}/${path}`, {}),
    onSuccess: refresh,
    onError: (e) => setError((e as Error).message),
  });

  const buttons: React.ReactNode[] = [];
  const editable = status === "DRAFT" || status === "RETURNED" || status === "REJECTED";

  // Dealer completion gate — mirrors Seasonal: every dealer must be Completed or No Plan.
  const canSubmit = totalDealers > 0 && remainingCount === 0;
  const doSubmit = () => {
    setConfirmNoPlan(false);
    act.mutate("submit");
  };
  if (isOwner && editable) {
    buttons.push(
      <Button
        key="submit"
        onClick={() => (noPlanDealers.length > 0 ? setConfirmNoPlan(true) : doSubmit())}
        disabled={act.isPending || !canSubmit}
        title={canSubmit ? undefined : `Account for every dealer first (${remainingCount} remaining).`}
      >
        Submit Monthly Plan
      </Button>,
    );
  }

  // Only reviewer action retained: Approve (view-only otherwise — no Return / Reject / Recall).
  const isRmApprover = role === Role.REGIONAL_MANAGER && status === "PENDING_RM";
  const isAdminApprover = role === Role.SUPER_ADMIN && status === "PENDING_ADMIN";
  if (isRmApprover || isAdminApprover) {
    buttons.push(
      <Button key="approve" onClick={() => act.mutate("approve")} disabled={act.isPending}>Approve</Button>,
    );
  }

  if (buttons.length === 0 && !error) return null;

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
            <p className="text-muted-foreground">The following dealers are marked as No Plan for this month and will be submitted as skipped:</p>
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
    </div>
  );
}
