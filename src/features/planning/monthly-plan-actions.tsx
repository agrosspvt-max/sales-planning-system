"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PlanStatus } from "./types";

/**
 * Monthly Plan workflow actions — the monthly analogue of PlanActions, driving the SAME
 * approval lifecycle (Officer → RM → Admin) against the monthly-plan endpoints.
 */
export function MonthlyPlanActions({
  monthlyPlanId,
  status,
  officerId,
  role,
  userId,
}: {
  monthlyPlanId: string;
  status: PlanStatus;
  officerId: string;
  role: Role;
  userId: string;
}) {
  const qc = useQueryClient();
  const [remarkKind, setRemarkKind] = useState<"return" | "reject" | null>(null);
  const [remarkText, setRemarkText] = useState("");
  const [error, setError] = useState<string | null>(null);

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
  const actWithBody = useMutation({
    mutationFn: (vars: { path: string; body: unknown }) => api.post(`${base}/${vars.path}`, vars.body),
    onSuccess: () => {
      setRemarkKind(null);
      setRemarkText("");
      refresh();
    },
    onError: (e) => setError((e as Error).message),
  });

  const buttons: React.ReactNode[] = [];
  const editable = status === "DRAFT" || status === "RETURNED" || status === "REJECTED";
  const pending = status === "PENDING_RM" || status === "PENDING_ADMIN";

  if (isOwner && editable) {
    buttons.push(
      <Button key="submit" onClick={() => act.mutate("submit")} disabled={act.isPending}>
        Submit for approval
      </Button>,
    );
  }
  if (isOwner && pending) {
    buttons.push(
      <Button key="recall" variant="outline" onClick={() => act.mutate("recall")}>
        Recall
      </Button>,
    );
  }

  const isRmApprover = role === Role.REGIONAL_MANAGER && status === "PENDING_RM";
  const isAdminApprover = role === Role.SUPER_ADMIN && status === "PENDING_ADMIN";
  if (isRmApprover || isAdminApprover) {
    buttons.push(
      <Button key="approve" onClick={() => act.mutate("approve")} disabled={act.isPending}>Approve</Button>,
      <Button key="return" variant="outline" onClick={() => { setError(null); setRemarkKind("return"); }}>Return</Button>,
      <Button key="reject" variant="destructive" onClick={() => { setError(null); setRemarkKind("reject"); }}>Reject</Button>,
    );
  }

  if (buttons.length === 0 && !error) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {buttons}
      {error && <span className="text-sm text-destructive">{error}</span>}

      <Dialog open={remarkKind !== null} onOpenChange={(o) => !o && setRemarkKind(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{remarkKind === "return" ? "Return monthly plan" : "Reject monthly plan"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="remark">Remarks</Label>
            <Textarea id="remark" value={remarkText} onChange={(e) => setRemarkText(e.target.value)} placeholder="Required" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemarkKind(null)}>Cancel</Button>
            <Button
              disabled={!remarkText.trim() || actWithBody.isPending}
              onClick={() => actWithBody.mutate({ path: remarkKind ?? "return", body: { remarks: remarkText.trim() } })}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
