"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, Check } from "lucide-react";
import { api } from "@/lib/api-client";
import { PLANNING_MODES, PLANNING_MODE_LABELS, type PlanningMode } from "@/lib/calc";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Config {
  seasonalMode: PlanningMode;
  monthlyMode: PlanningMode;
}

const MODE_HELP: Record<PlanningMode, string> = {
  PACK_SIZE: "Officers enter a quantity for every pack size (current behaviour).",
  TOTAL_QUANTITY: "Officers enter one Total Quantity per product. No pack columns.",
  AMOUNT: "Officers enter a planned Amount per product.",
  NBV: "Officers enter a planned NBV per product.",
};

export function PlanningConfigPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Config>({
    queryKey: ["planning-config"],
    queryFn: () => api.get<Config>("/api/settings/planning-config"),
  });

  const [seasonalMode, setSeasonalMode] = useState<PlanningMode>("PACK_SIZE");
  const [monthlyMode, setMonthlyMode] = useState<PlanningMode>("PACK_SIZE");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setSeasonalMode(data.seasonalMode);
      setMonthlyMode(data.monthlyMode);
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () =>
      api.put<Config>("/api/settings/planning-config", { seasonalMode, monthlyMode }),
    onSuccess: (c) => {
      qc.setQueryData(["planning-config"], c);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const dirty = !!data && (data.seasonalMode !== seasonalMode || data.monthlyMode !== monthlyMode);

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader
        title="Planning Configuration"
        subtitle={
          <>
            Sets the <span className="font-medium">default</span> planning mode for{" "}
            <span className="font-medium">new</span> seasons. Each season stores its own Seasonal and
            Monthly modes (prefilled from these defaults when created) and always uses them, so changing
            the default here never affects existing seasons or historical reports.
          </>
        }
      />

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <ModeCard
            title="Seasonal Planning"
            name="seasonal"
            value={seasonalMode}
            onChange={setSeasonalMode}
          />
          <ModeCard
            title="Monthly Planning"
            name="monthly"
            value={monthlyMode}
            onChange={setMonthlyMode}
          />

          <div className="flex items-center gap-3">
            <Button onClick={() => saveMut.mutate()} disabled={!dirty || saveMut.isPending}>
              {saveMut.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
              ) : (
                <><Save className="h-4 w-4" /> Save</>
              )}
            </Button>
            {saved && (
              <span className="flex items-center gap-1 text-sm text-success">
                <Check className="h-4 w-4" /> Saved
              </span>
            )}
            {saveMut.isError && (
              <span className="text-sm text-destructive">{(saveMut.error as Error).message}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ModeCard({
  title,
  name,
  value,
  onChange,
}: {
  title: string;
  name: string;
  value: PlanningMode;
  onChange: (m: PlanningMode) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {PLANNING_MODES.map((mode) => (
          <label
            key={mode}
            className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted/40"
          >
            <input
              type="radio"
              name={name}
              className="mt-1"
              checked={value === mode}
              onChange={() => onChange(mode)}
            />
            <span>
              <span className="text-sm font-medium">{PLANNING_MODE_LABELS[mode]}</span>
              <span className="block text-xs text-muted-foreground">{MODE_HELP[mode]}</span>
            </span>
          </label>
        ))}
      </CardContent>
    </Card>
  );
}
