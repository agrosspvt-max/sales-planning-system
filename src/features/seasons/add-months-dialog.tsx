"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import {
  identity,
  monthLabel,
  calendarPeriod,
  validateAddMonths,
  type CalendarMonth,
  type MonthIdentity,
} from "@/lib/season-calendar";
import { formatPeriod } from "@/lib/season-months";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function AddMonthsDialog({
  season,
  onClose,
}: {
  season: { id: string; name: string };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [candidate, setCandidate] = useState("");
  const [selected, setSelected] = useState<CalendarMonth[]>([]);
  const [error, setError] = useState<string | null>(null);
  const {
    data: months,
    isPending,
    error: loadError,
  } = useQuery<(MonthIdentity & { name: string })[]>({
    queryKey: ["season-months", season.id],
    queryFn: () => api.get(`/api/seasons/${season.id}/months`),
  });
  let preview: ReturnType<typeof validateAddMonths> | undefined;
  let previewError: string | undefined;
  if (months && selected.length) {
    try {
      preview = validateAddMonths(months, selected);
    } catch (e) {
      previewError = (e as Error).message;
    }
  }
  const current =
    months?.length && months.every((m) => identity(m))
      ? calendarPeriod(months.map((m) => identity(m)!))
      : null;
  const unresolved = months?.some((m) => !identity(m));
  const mutation = useMutation({
    mutationFn: () => api.post(`/api/seasons/${season.id}/months`, { months: selected }),
    onSuccess: async () => {
      await Promise.all(
        [
          "seasons",
          "season-months",
          "season-plan-months",
          "sales-upload-months",
          "monthly",
          "monthly-plan",
          "group-product-plan",
          "group-recovery",
          "report",
          "dashboard",
          "profile",
          "daily-work",
        ].map((key) => qc.invalidateQueries({ queryKey: [key] })),
      );
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });
  function selectMonth() {
    const match = /^(\d{4})-(\d{2})$/.exec(candidate);
    if (!match) {
      setError("Select a month and year.");
      return;
    }
    const value = { year: Number(match[1]), month: Number(match[2]) };
    if (
      months?.some((m) => m.calendarMonth === value.month && m.calendarYear === value.year) ||
      selected.some((m) => m.month === value.month && m.year === value.year)
    ) {
      setError("This calendar month already exists or is selected.");
      return;
    }
    setSelected([...selected, value].sort((a, b) => a.year * 12 + a.month - b.year * 12 - b.month));
    setError(null);
    setCandidate("");
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Months</DialogTitle>
          <DialogDescription className="sr-only">
            Add calendar months while preserving existing planning and financial records.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          <strong>Season:</strong> {season.name}
        </p>
        {current && (
          <p className="text-sm">
            <strong>Current Period:</strong>{" "}
            {formatPeriod(current.startMonth, current.startYear, current.endMonth, current.endYear)}
          </p>
        )}
        <p className="text-sm">
          <strong>Current months:</strong> {months?.map(monthLabel).join(", ") ?? "Loading…"}
        </p>
        {loadError && <p className="text-sm text-destructive">{loadError.message}</p>}
        {unresolved && (
          <p className="text-sm text-destructive">
            Existing calendar identity needs review before adding months.
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="add-season-month">Select months to add</Label>
          <div className="flex gap-2">
            <Input
              id="add-season-month"
              type="month"
              min="2000-01"
              max="2100-12"
              value={candidate}
              disabled={isPending || !!loadError || unresolved || mutation.isPending}
              onChange={(e) => setCandidate(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={!candidate || isPending || !!loadError || unresolved || mutation.isPending}
              onClick={selectMonth}
            >
              Select
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {selected.map((m) => (
              <Button
                key={`${m.year}-${m.month}`}
                size="sm"
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => setSelected(selected.filter((x) => x !== m))}
                title="Remove selection"
              >
                {monthLabel({ name: "", calendarYear: m.year, calendarMonth: m.month })} ×
              </Button>
            ))}
          </div>
        </div>
        {preview && (
          <p className="text-sm">
            <strong>New Period:</strong>{" "}
            {formatPeriod(
              preview.newPeriod.startMonth,
              preview.newPeriod.startYear,
              preview.newPeriod.endMonth,
              preview.newPeriod.endYear,
            )}
          </p>
        )}
        {(error || previewError) && (
          <p role="alert" className="text-sm text-destructive">
            {error || previewError}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!preview || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Adding…" : "Add Months"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
