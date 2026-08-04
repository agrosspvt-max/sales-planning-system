import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS, type PlanStatus } from "./types";

const VARIANT: Record<PlanStatus, "default" | "secondary" | "success" | "muted" | "destructive"> = {
  DRAFT: "muted",
  PENDING_RM: "secondary",
  PENDING_ADMIN: "secondary",
  APPROVED: "success",
  RETURNED: "default",
  REJECTED: "destructive",
};

export function StatusBadge({ status }: { status: PlanStatus }) {
  return <Badge variant={VARIANT[status]}>{STATUS_LABELS[status]}</Badge>;
}

/**
 * Combined plan state: the lifecycle (CLOSED / DEACTIVATED) takes precedence over the approval
 * status, so a closed approved plan reads "Closed" not "Approved". ACTIVE falls back to the
 * approval StatusBadge. One badge used by the admin list and the officer plan-management table.
 */
export function PlanStateBadge({ status, lifecycleState }: { status: PlanStatus; lifecycleState?: string }) {
  if (lifecycleState === "CLOSED") return <Badge variant="secondary">Closed</Badge>;
  if (lifecycleState === "DEACTIVATED") return <Badge variant="muted">Deactivated</Badge>;
  return <StatusBadge status={status} />;
}
