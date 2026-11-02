"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { RemoveMonthDialog } from "./remove-month-dialog";
import { announcePlanningPeriodChange } from "@/lib/planning-period-cache";
import { useLabel } from "@/features/labels/label-ui";
import { monthLabel, type MonthIdentity } from "@/lib/season-calendar";
import { api } from "@/lib/api-client";
import {
  MONTH_STATUS_LABELS,
  MONTH_TRANSITIONS,
  type MonthStatus,
} from "@/features/planning/planning-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface MonthState extends MonthIdentity {
  id: string;
  name: string;
  order: number;
  status: MonthStatus;
  editable: boolean;
}

const ACTION_LABEL: Record<MonthStatus, string> = {
  LOCKED: "Open",
  OPEN: "Close",
  CLOSED: "Reopen",
};

/** Management (Super Admin) opens / closes / reopens the months of a season (Open-Month, §42). */
export function SeasonMonthsDialog({
  seasonId,
  seasonName,
  open,
  onOpenChange,
}: {
  seasonId: string | null;
  seasonName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [removing, setRemoving] = useState<string | null>(null);
  const removeLabel = useLabel("seasons.remove.action");
  const visibilityHelp = useLabel("seasons.months.visibility_help");
  const { data, isLoading } = useQuery<MonthState[]>({
    queryKey: ["season-months", seasonId],
    queryFn: () => api.get<MonthState[]>(`/api/seasons/${seasonId}/months`),
    enabled: open && !!seasonId,
  });

  const setStatus = useMutation({
    mutationFn: (vars: { id: string; status: MonthStatus }) =>
      api.post(`/api/season-months/${vars.id}/status`, { status: vars.status }),
    onSuccess: () => announcePlanningPeriodChange(qc),
  });

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!removing) onOpenChange(value);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Planning months — {seasonName}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {visibilityHelp}
          </p>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="space-y-1.5">
              {(data ?? []).map((m) => {
                const next = MONTH_TRANSITIONS[m.status][0];
                return (
                  <div
                    key={m.id}
                    className="flex items-center justify-between rounded-md border p-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {m.order}. {monthLabel(m)}
                      </span>
                      <Badge variant={m.status === "OPEN" ? "success" : "muted"}>
                        {MONTH_STATUS_LABELS[m.status]}
                      </Badge>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant={m.status === "OPEN" ? "outline" : "default"}
                        disabled={setStatus.isPending}
                        onClick={() => setStatus.mutate({ id: m.id, status: next })}
                      >
                        {setStatus.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          ACTION_LABEL[m.status]
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={setStatus.isPending}
                        onClick={() => setRemoving(m.id)}
                      >
                        {removeLabel}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
      {open && removing && seasonId && (
        <RemoveMonthDialog
          key={removing}
          seasonId={seasonId}
          monthId={removing}
          onClose={() => setRemoving(null)}
          onTransferred={() => setRemoving(null)}
        />
      )}
    </>
  );
}
