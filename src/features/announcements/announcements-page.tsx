"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";

interface AnnouncementItem {
  id: string;
  title: string;
  body: string;
  audienceRole: string | null;
  activeTo: string | null;
  createdAt: string;
  isRead: boolean;
  isExpired: boolean;
}

export function AnnouncementsPage() {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<AnnouncementItem[]>({
    queryKey: ["announcements-feed", showAll],
    queryFn: () => api.get<AnnouncementItem[]>(`/api/announcements?filter=${showAll ? "all" : "active"}`),
  });

  const readMut = useMutation({
    mutationFn: (id: string) => api.post(`/api/announcements/${id}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["announcements-feed"] }),
  });

  function toggle(a: AnnouncementItem) {
    const next = openId === a.id ? null : a.id;
    setOpenId(next);
    if (next && !a.isRead) readMut.mutate(a.id);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Announcements"
        subtitle="Messages from your administrators."
        actions={
          <Button variant="outline" size="sm" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Show active only" : "Show all (incl. expired)"}
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (data?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">No announcements.</CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {data!.map((a) => (
            <div key={a.id} className="rounded-lg border bg-background">
              <button
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent"
                onClick={() => toggle(a)}
              >
                <div className="flex items-center gap-2">
                  {!a.isRead && <span className="h-2 w-2 rounded-full bg-primary" />}
                  <span className="font-medium">{a.title}</span>
                  {a.isExpired && <Badge variant="muted">Expired</Badge>}
                </div>
                <span className="text-xs text-muted-foreground">{formatDate(a.createdAt)}</span>
              </button>
              {openId === a.id && (
                <div className="border-t px-4 py-3 text-sm">
                  <p className="whitespace-pre-wrap">{a.body}</p>
                  {a.activeTo && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Active until {formatDate(a.activeTo)}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
