"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DealerPlanningStatus } from "./dealer-status";
import type { PlanDealerDetail } from "./types";

export { DealerPlanningStatus } from "./dealer-status";
export type { DealerPlanningStatus as DealerStatus } from "./dealer-status";

/** Completion for a dealer from its SAVED plan lines (≥1 stored quantity). */
export function detailDealerHasQty(dealer: PlanDealerDetail): boolean {
  return dealer.lines.some(
    (l) => (l.inputValue != null && l.inputValue > 0) || Object.values(l.packs).some((q) => q > 0),
  );
}

export function dealerStatusOf(dealer: PlanDealerDetail, completed: boolean): DealerPlanningStatus {
  if (dealer.noPlan) return DealerPlanningStatus.NO_PLAN;
  return completed ? DealerPlanningStatus.COMPLETED : DealerPlanningStatus.REMAINING;
}

/** Tailwind text colour for a dealer status (Completed = green, No Plan = purple). */
export const STATUS_TEXT: Record<DealerPlanningStatus, string> = {
  [DealerPlanningStatus.COMPLETED]: "text-success",
  [DealerPlanningStatus.NO_PLAN]: "text-noplan",
  [DealerPlanningStatus.REMAINING]: "text-foreground",
};

export interface StatusCounts {
  completed: number;
  noPlan: number;
  remaining: number;
  total: number;
}

/** Live planning progress bar (Green Completed · Purple No Plan · Grey Remaining). */
export function DealerProgressBar({ counts }: { counts: StatusCounts }) {
  const { completed, noPlan, remaining, total } = counts;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{total} Dealers</span>
        <span className="flex flex-wrap gap-x-3 text-xs">
          <span className="text-success">{completed} Completed</span>
          <span className="text-noplan">{noPlan} No Plan</span>
          <span className="text-muted-foreground">{remaining} Remaining</span>
        </span>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="bg-success" style={{ width: `${pct(completed)}%` }} />
        <div className="bg-noplan" style={{ width: `${pct(noPlan)}%` }} />
      </div>
    </div>
  );
}

/** Dialog to mark a dealer "No Plan" with an optional reason. */
const REASONS = ["Inactive Dealer", "Dealer Closed", "No Demand", "Business Stopped", "Season Skip", "Other"];

export function NoPlanDialog({
  open,
  dealerName,
  onOpenChange,
  onConfirm,
  saving,
}: {
  open: boolean;
  dealerName: string;
  onOpenChange: (o: boolean) => void;
  onConfirm: (reason: string | undefined) => void;
  saving?: boolean;
}) {
  const [reason, setReason] = useState("");
  const [other, setOther] = useState("");
  const finalReason = reason === "Other" ? other.trim() || undefined : reason || undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark “{dealerName}” as No Plan</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This dealer will be intentionally skipped for this plan. A reason is optional.
          </p>
          <div className="space-y-1.5">
            <Label>Reason (optional)</Label>
            <NativeSelect
              placeholder="Select a reason…"
              options={REASONS.map((r) => ({ value: r, label: r }))}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {reason === "Other" && (
            <Input placeholder="Describe the reason" value={other} onChange={(e) => setOther(e.target.value)} />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => onConfirm(finalReason)} disabled={saving} className={cn(saving && "opacity-70")}>
            {saving ? "Saving…" : "Mark No Plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
