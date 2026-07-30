"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./status-badge";
import type { PlanStatus, TimelineItem, VersionItem } from "./types";

const ACTION_LABELS: Record<string, string> = {
  SUBMIT: "Submitted",
  RECALL: "Recalled",
  APPROVE: "Approved",
  RETURN: "Returned",
  REJECT: "Rejected",
  REQUEST_REVISION: "Revision requested",
  AUTHORIZE_REVISION: "Revision authorized",
};

export function PlanHistory({ planId }: { planId: string }) {
  const { data, isLoading } = useQuery<{ versions: VersionItem[]; timeline: TimelineItem[] }>({
    queryKey: ["plan-history", planId],
    queryFn: () => api.get(`/api/planning/season-plans/${planId}/history`),
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold">Versions</h3>
        <div className="flex flex-wrap gap-2">
          {data.versions.map((v) => (
            <Link
              key={v.id}
              href={`/planning/${v.id}`}
              className="rounded-md border px-3 py-2 text-sm hover:bg-accent"
            >
              <span className="font-medium">v{v.version}</span>{" "}
              <StatusBadge status={v.status as PlanStatus} />
              {v.isActiveVersion && (
                <Badge variant="success" className="ml-1">
                  Active
                </Badge>
              )}
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Status timeline</h3>
        <ol className="space-y-3 border-l pl-4">
          {data.timeline.map((t) => (
            <li key={t.id} className="relative">
              <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-primary" />
              <div className="text-sm">
                <span className="font-medium">{ACTION_LABELS[t.action] ?? t.action}</span> by{" "}
                {t.actorName}
                <span className="ml-2 text-xs text-muted-foreground">{formatDate(t.createdAt)}</span>
              </div>
              {t.remarks && <p className="text-sm text-muted-foreground">“{t.remarks}”</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
