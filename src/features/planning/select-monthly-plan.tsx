"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PlanStatus } from "./types";

interface MonthInfo {
  id: string;
  name: string;
  order: number;
  monthlyPlan: { id: string; status: PlanStatus } | null;
}
interface SeasonMonthsResp {
  seasonName: string;
  months: MonthInfo[];
}

const EDITABLE: PlanStatus[] = ["DRAFT", "RETURNED", "REJECTED"];

/**
 * From an approved seasonal plan, "Monthly Planning" first asks which Monthly Plan to open:
 * a Draft (create/continue) or an Approved one (read-only). Then only the relevant months are
 * shown; choosing a month opens that first-class Monthly Plan.
 */
export function SelectMonthlyPlanDialog({
  seasonPlanId,
  open,
  onOpenChange,
}: {
  seasonPlanId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"draft" | "approved">("draft");
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<SeasonMonthsResp>({
    queryKey: ["season-plan-months", seasonPlanId],
    queryFn: () => api.get<SeasonMonthsResp>(`/api/planning/season-plans/${seasonPlanId}/months`),
    enabled: open,
  });

  const createMut = useMutation({
    mutationFn: (seasonMonthId: string) =>
      api.post<{ id: string }>("/api/planning/monthly-plans", { seasonPlanId, seasonMonthId }),
    onSuccess: (res) => router.push(`/planning/monthly/${res.id}`),
    onError: (e) => setError((e as Error).message),
  });

  const months = data?.months ?? [];
  const draftMonths = months.filter((m) => !m.monthlyPlan || EDITABLE.includes(m.monthlyPlan.status));
  const approvedMonths = months.filter((m) => m.monthlyPlan?.status === "APPROVED");
  const shown = mode === "draft" ? draftMonths : approvedMonths;

  function openMonth(m: MonthInfo) {
    setError(null);
    if (m.monthlyPlan) router.push(`/planning/monthly/${m.monthlyPlan.id}`);
    else createMut.mutate(m.id);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Monthly Plan</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
            <button
              onClick={() => setMode("draft")}
              className={cn("rounded px-3 py-1.5 font-medium", mode === "draft" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
            >
              Open Draft Monthly Plan
            </button>
            <button
              onClick={() => setMode("approved")}
              className={cn("rounded px-3 py-1.5 font-medium", mode === "approved" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
            >
              View Approved Monthly Plan
            </button>
          </div>

          {isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : shown.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {mode === "draft"
                ? "No months available to draft. Create one from Create New Plan → Monthly."
                : "No approved monthly plans yet."}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {shown.map((m) => (
                <Button
                  key={m.id}
                  variant="outline"
                  size="sm"
                  disabled={createMut.isPending}
                  onClick={() => openMonth(m)}
                >
                  {m.name}
                  {m.monthlyPlan ? ` · ${m.monthlyPlan.status}` : " · New"}
                </Button>
              ))}
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
