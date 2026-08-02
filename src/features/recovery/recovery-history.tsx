"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import type { TimelineItem } from "@/features/planning/types";

const ACTION_LABELS: Record<string, string> = { SUBMIT: "Submitted", RECALL: "Recalled", APPROVE: "Approved", RETURN: "Returned", REJECT: "Rejected" };

/** Recovery approval timeline — reuses the shared ApprovalAction history shape. */
export function RecoveryHistory({ id }: { id: string }) {
  const { data, isLoading } = useQuery<{ timeline: TimelineItem[] }>({
    queryKey: ["recovery-history", id],
    queryFn: () => api.get(`/api/recovery/plans/${id}/history`),
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.timeline.length === 0) return <p className="text-sm text-muted-foreground">No actions yet.</p>;
  return (
    <ol className="space-y-3 border-l pl-4">
      {data.timeline.map((t) => (
        <li key={t.id} className="relative">
          <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-primary" />
          <div className="text-sm">
            <span className="font-medium">{ACTION_LABELS[t.action] ?? t.action}</span> by {t.actorName}
            <span className="ml-2 text-xs text-muted-foreground">{formatDate(t.createdAt)}</span>
          </div>
          {t.remarks && <p className="text-sm text-muted-foreground">“{t.remarks}”</p>}
        </li>
      ))}
    </ol>
  );
}
