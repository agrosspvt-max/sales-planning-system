"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  isRead: boolean;
  createdAt: string;
}

interface Feed {
  items: NotificationItem[];
  unread: number;
}

function hrefFor(n: NotificationItem): string | null {
  if (n.relatedEntityType === "SeasonPlan" && n.relatedEntityId) return `/planning/${n.relatedEntityId}`;
  if (n.relatedEntityType === "Announcement") return `/announcements`;
  return null;
}

export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data } = useQuery<Feed>({
    queryKey: ["notifications"],
    queryFn: () => api.get<Feed>("/api/notifications"),
    refetchInterval: 60_000,
  });

  const readOne = useMutation({
    mutationFn: (id: string) => api.post(`/api/notifications/${id}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const readAll = useMutation({
    mutationFn: () => api.post(`/api/notifications/read-all`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        title="Notifications"
        onClick={() => setOpen((o) => !o)}
        className="relative"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 rounded-md border bg-popover shadow-lg">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-semibold">Notifications</span>
              {unread > 0 && (
                <button
                  className="text-xs text-primary hover:underline"
                  onClick={() => readAll.mutate()}
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-auto">
              {items.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No notifications.
                </p>
              ) : (
                items.map((n) => {
                  const href = hrefFor(n);
                  const body = (
                    <div
                      className={cn(
                        "cursor-pointer border-b px-3 py-2 hover:bg-accent",
                        !n.isRead && "bg-primary/5",
                      )}
                      onClick={() => {
                        if (!n.isRead) readOne.mutate(n.id);
                        setOpen(false);
                      }}
                    >
                      <div className="flex items-start gap-2">
                        {!n.isRead && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{n.title}</p>
                          <p className="truncate text-xs text-muted-foreground">{n.message}</p>
                          <p className="text-[10px] text-muted-foreground">{formatDate(n.createdAt)}</p>
                        </div>
                      </div>
                    </div>
                  );
                  return href ? (
                    <Link key={n.id} href={href}>
                      {body}
                    </Link>
                  ) : (
                    <div key={n.id}>{body}</div>
                  );
                })
              )}
            </div>
            <Link
              href="/notifications"
              className="block border-t px-3 py-2 text-center text-xs text-primary hover:underline"
              onClick={() => setOpen(false)}
            >
              View all
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
