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

/** Dialog to mark a dealer "No Plan" with a reason. */
const REASONS = ["Inactive Dealer", "Dealer Closed", "No Demand", "Business Stopped", "Season Skip", "Other"];

/**
 * `captureDetail` (Recovery) keeps the selected reason AND a separate required detail when "Other" is
 * chosen — onConfirm(reason, detail). Default (Monthly) is unchanged: reason is optional and "Other"
 * merges the custom text into the reason string, onConfirm(reason).
 */
export function NoPlanDialog({
  open,
  dealerName,
  onOpenChange,
  onConfirm,
  saving,
  reasons = REASONS,
  captureDetail = false,
}: {
  open: boolean;
  dealerName: string;
  onOpenChange: (o: boolean) => void;
  onConfirm: (reason: string | undefined, detail?: string) => void;
  saving?: boolean;
  reasons?: string[];
  captureDetail?: boolean;
}) {
  const [reason, setReason] = useState("");
  const [other, setOther] = useState("");

  const isOther = reason === "Other";
  // Recovery: require a reason, and require the detail when "Other". Monthly: nothing required.
  const disabled = !!saving || (captureDetail && (!reason || (isOther && other.trim().length === 0)));

  const confirm = () => {
    if (captureDetail) {
      onConfirm(reason || undefined, isOther ? other.trim() : undefined);
    } else {
      onConfirm(isOther ? other.trim() || undefined : reason || undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark “{dealerName}” as No Plan</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This dealer will be intentionally skipped for this plan.{captureDetail ? " Select a reason." : " A reason is optional."}
          </p>
          <div className="space-y-1.5">
            <Label>{captureDetail ? "Reason *" : "Reason (optional)"}</Label>
            <NativeSelect
              placeholder="Select a reason…"
              options={reasons.map((r) => ({ value: r, label: r }))}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {isOther && (
            <div className="space-y-1.5">
              {captureDetail && <Label>Enter reason *</Label>}
              <Input placeholder={captureDetail ? "Enter reason" : "Describe the reason"} value={other} onChange={(e) => setOther(e.target.value)} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={confirm} disabled={disabled} className={cn(saving && "opacity-70")}>
            {saving ? "Saving…" : "Mark No Plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
