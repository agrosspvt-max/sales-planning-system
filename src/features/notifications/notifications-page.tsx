"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import type { NotificationItem } from "./notification-bell";

interface Feed {
  items: NotificationItem[];
  unread: number;
}

function hrefFor(n: NotificationItem): string | null {
  if (n.relatedEntityType === "SeasonPlan" && n.relatedEntityId) return `/planning/${n.relatedEntityId}`;
  if (n.relatedEntityType === "Announcement") return `/announcements`;
  return null;
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Feed>({
    queryKey: ["notifications"],
    queryFn: () => api.get<Feed>("/api/notifications"),
  });
  const readAll = useMutation({
    mutationFn: () => api.post(`/api/notifications/read-all`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const readOne = useMutation({
    mutationFn: (id: string) => api.post(`/api/notifications/${id}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notifications"
        subtitle="Your recent activity."
        actions={
          (data?.unread ?? 0) > 0 ? (
            <Button variant="outline" size="sm" onClick={() => readAll.mutate()}>
              Mark all read
            </Button>
          ) : undefined
        }
      />

      <div className="rounded-lg border bg-background">
        {isLoading ? (
          <div className="p-4">
            <Skeleton className="h-6 w-full" />
          </div>
        ) : (data?.items.length ?? 0) === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No notifications.</p>
        ) : (
          data!.items.map((n) => {
            const href = hrefFor(n);
            const inner = (
              <div
                className={cn(
                  "cursor-pointer border-b px-4 py-3 hover:bg-accent",
                  !n.isRead && "bg-primary/5",
                )}
                onClick={() => !n.isRead && readOne.mutate(n.id)}
              >
                <div className="flex items-start gap-2">
                  {!n.isRead && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                  <div>
                    <p className="text-sm font-medium">{n.title}</p>
                    <p className="text-sm text-muted-foreground">{n.message}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(n.createdAt)}</p>
                  </div>
                </div>
              </div>
            );
            return href ? (
              <Link key={n.id} href={href}>
                {inner}
              </Link>
            ) : (
              <div key={n.id}>{inner}</div>
            );
          })
        )}
      </div>
    </div>
  );
}
