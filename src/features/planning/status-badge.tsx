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
