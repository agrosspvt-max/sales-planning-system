"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PlanStage } from "@/lib/monthly-plan";
import { useLabel } from "@/features/labels/label-ui";
import { useLabels } from "./party-labels";

/** Shared pieces of the Party Planning Seasonal / Monthly LIST pages (the same list → create → Open pattern as Sales Planning). */

export const dateTimeText = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium" });

const STATUS_VARIANT: Record<string, "muted" | "secondary" | "success" | "destructive" | "warning"> = {
  Draft: "muted", "Pending Approval": "secondary", Approved: "success", "Needs Changes": "destructive", "In Progress": "secondary", Completed: "success",
  "Awaiting RM review": "secondary", "Awaiting Admin review": "secondary", Rejected: "destructive",
};
/** `status` is the stable English status text (it picks the colour); the text SHOWN is its editable label. */
export function SheetStatusBadge({ status }: { status: string }) {
  const T = useLabels({
    "Draft": "party_planning.status.draft", "Pending Approval": "party_planning.status.pending_approval", "Approved": "party_planning.status.approved",
    "Needs Changes": "party_planning.status.needs_changes", "Needs changes": "party_planning.status.needs_changes", "In Progress": "party_planning.status.in_progress", "Completed": "party_planning.status.completed",
    "Awaiting RM review": "party_planning.status.awaiting_rm", "Awaiting Admin review": "party_planning.status.awaiting_admin", "Awaiting approval": "party_planning.status.awaiting_approval",
    "Rejected": "party_planning.status.rejected", "Ready for new markets": "party_planning.status.ready_new", "Older plan": "party_planning.status.older_plan",
  });
  return <Badge variant={STATUS_VARIANT[status] ?? "muted"}>{(T as Record<string, string>)[status] ?? status}</Badge>;
}

/** The "Open" action: a plain route link (like Sales Planning's Open), so Back / Forward / refresh follow the URL. */
export function OpenButton({ href }: { href: string }) {
  const label = useLabel("party_planning.common.open");
  return <Button asChild variant="outline" size="sm"><Link href={href}>{label}</Link></Button>;
}

interface StageCounts { create: number; submitted: number; approved: number; pendingRm?: number; rejected?: number }
/** How many of a plan's entries belong to the section being listed (Older Plans: all of them). */
export const stageCount = (counts: StageCounts, itemCount: number, stage: PlanStage): number => (stage === "older" ? itemCount : counts[stage]);
/** The status shown for a plan IN a section — a plan can hold Draft, Submitted and Approved entries at once, so the label describes the section, not the whole plan. */
export function stageStatusLabel(counts: StageCounts, stage: PlanStage): string {
  if (stage === "create") return counts.create === 0 ? "Ready for new markets" : (counts.rejected ?? 0) > 0 ? "Needs changes" : "Draft";
  if (stage === "submitted") return counts.pendingRm === undefined ? "Awaiting approval" : counts.pendingRm > 0 ? "Awaiting RM review" : "Awaiting Admin review";
  if (stage === "approved") return "Approved";
  return "Older plan";
}
