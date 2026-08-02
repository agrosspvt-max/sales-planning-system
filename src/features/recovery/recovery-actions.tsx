"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PlanStatus } from "@/features/planning/types";

interface NoPlanDealer { dealerId: string; dealerName: string; noPlanReason: string | null }

/** Recovery Plan workflow actions — reuses the same approval endpoints/UX as Monthly/Seasonal. */
export function RecoveryActions({
  id, status, officerId, role, userId, remainingCount, totalDealers, noPlanDealers,
}: {
  id: string; status: PlanStatus; officerId: string; role: Role; userId: string;
  remainingCount: number; totalDealers: number; noPlanDealers: NoPlanDealer[];
}) {
  const qc = useQueryClient();
  const [remarkKind, setRemarkKind] = useState<"return" | "reject" | null>(null);
  const [remarkText, setRemarkText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmNoPlan, setConfirmNoPlan] = useState(false);

  const base = `/api/recovery/plans/${id}`;
  const isOwner = role === Role.SALES_OFFICER && officerId === userId;
  const editable = status === "DRAFT" || status === "RETURNED" || status === "REJECTED";
  const pending = status === "PENDING_RM" || status === "PENDING_ADMIN";
  const canSubmit = totalDealers > 0 && remainingCount === 0;

  function refresh() {
    qc.invalidateQueries({ queryKey: ["recovery-plan", id] });
    qc.invalidateQueries({ queryKey: ["recovery-plans"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  }
  const act = useMutation({ mutationFn: (path: string) => api.post(`${base}/${path}`, {}), onSuccess: refresh, onError: (e) => setError((e as Error).message) });
  const actBody = useMutation({
    mutationFn: (vars: { path: string; body: unknown }) => api.post(`${base}/${vars.path}`, vars.body),
    onSuccess: () => { setRemarkKind(null); setRemarkText(""); refresh(); },
    onError: (e) => setError((e as Error).message),
  });
  const doSubmit = () => { setConfirmNoPlan(false); act.mutate("submit"); };

  const buttons: React.ReactNode[] = [];
  if (isOwner && editable) {
    buttons.push(
      <Button key="submit" onClick={() => (noPlanDealers.length > 0 ? setConfirmNoPlan(true) : doSubmit())} disabled={act.isPending || !canSubmit} title={canSubmit ? undefined : `Account for every dealer first (${remainingCount} remaining).`}>
        Submit Recovery Plan
      </Button>,
    );
  }
  if (isOwner && pending) buttons.push(<Button key="recall" variant="outline" onClick={() => act.mutate("recall")}>Recall</Button>);
  const isRm = role === Role.REGIONAL_MANAGER && status === "PENDING_RM";
  const isAdmin = role === Role.SUPER_ADMIN && status === "PENDING_ADMIN";
  if (isRm || isAdmin) {
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

      <Dialog open={remarkKind !== null} onOpenChange={(o) => !o && setRemarkKind(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{remarkKind === "return" ? "Return recovery plan" : "Reject recovery plan"}</DialogTitle></DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="remark">Remarks</Label>
            <Textarea id="remark" value={remarkText} onChange={(e) => setRemarkText(e.target.value)} placeholder="Required" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemarkKind(null)}>Cancel</Button>
            <Button disabled={!remarkText.trim() || actBody.isPending} onClick={() => actBody.mutate({ path: remarkKind ?? "return", body: { remarks: remarkText.trim() } })}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
