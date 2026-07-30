"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { detailDealerHasQty } from "./dealer-completion";
import type { PlanDetail } from "./types";

interface Props {
  detail: PlanDetail;
  role: Role;
  userId: string;
}

type RemarkKind = "return" | "reject" | "request-revision" | null;

export function PlanActions({ detail, role, userId }: Props) {
  const qc = useQueryClient();
  const router = useRouter();
  const [remarkKind, setRemarkKind] = useState<RemarkKind>(null);
  const [remarkText, setRemarkText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmNoPlan, setConfirmNoPlan] = useState(false);

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
  const actWithBody = useMutation({
    mutationFn: (vars: { path: string; body: unknown }) => api.post(`${base}/${vars.path}`, vars.body),
    onSuccess: () => {
      setRemarkKind(null);
      setRemarkText("");
      refresh();
    },
    onError: (e) => setError((e as Error).message),
  });
  const authorize = useMutation({
    mutationFn: () => api.post<{ id: string }>(`${base}/authorize-revision`, {}),
    onSuccess: (res) => router.push(`/planning/${res.id}`),
    onError: (e) => setError((e as Error).message),
  });

  const buttons: React.ReactNode[] = [];

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
  if (isOwner && (detail.status === "PENDING_RM" || detail.status === "PENDING_ADMIN")) {
    buttons.push(
      <Button key="recall" variant="outline" onClick={() => act.mutate("recall")}>
        Recall
      </Button>,
    );
  }
  if (isOwner && detail.status === "APPROVED" && detail.isActiveVersion) {
    buttons.push(
      <Button
        key="req-rev"
        variant="outline"
        onClick={() => {
          setError(null);
          setRemarkKind("request-revision");
        }}
        disabled={detail.revisionRequested}
      >
        {detail.revisionRequested ? "Revision requested" : "Request revision"}
      </Button>,
    );
  }

  const isRmApprover = role === Role.REGIONAL_MANAGER && detail.status === "PENDING_RM";
  const isAdminApprover = role === Role.SUPER_ADMIN && detail.status === "PENDING_ADMIN";
  if (isRmApprover || isAdminApprover) {
    buttons.push(
      <Button key="approve" onClick={() => act.mutate("approve")} disabled={act.isPending}>
        Approve
      </Button>,
      <Button key="return" variant="outline" onClick={() => { setError(null); setRemarkKind("return"); }}>
        Return
      </Button>,
      <Button key="reject" variant="destructive" onClick={() => { setError(null); setRemarkKind("reject"); }}>
        Reject
      </Button>,
    );
  }
  if (role === Role.SUPER_ADMIN && detail.status === "APPROVED" && detail.revisionRequested) {
    buttons.push(
      <Button key="authorize" onClick={() => authorize.mutate()} disabled={authorize.isPending}>
        Authorize revision
      </Button>,
    );
  }

  const remarkTitle =
    remarkKind === "return"
      ? "Return plan with remarks"
      : remarkKind === "reject"
        ? "Reject plan with remarks"
        : "Request a revision";
  const remarkField = remarkKind === "request-revision" ? "reason" : "remarks";
  const remarkPath =
    remarkKind === "request-revision" ? "request-revision" : (remarkKind ?? "return");

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

      <Dialog open={remarkKind !== null} onOpenChange={(o) => !o && setRemarkKind(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{remarkTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="remark">{remarkKind === "request-revision" ? "Reason" : "Remarks"}</Label>
            <Textarea
              id="remark"
              value={remarkText}
              onChange={(e) => setRemarkText(e.target.value)}
              placeholder="Required"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemarkKind(null)}>
              Cancel
            </Button>
            <Button
              disabled={!remarkText.trim() || actWithBody.isPending}
              onClick={() =>
                actWithBody.mutate({ path: remarkPath, body: { [remarkField]: remarkText.trim() } })
              }
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
