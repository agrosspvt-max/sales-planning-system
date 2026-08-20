"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, Check } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface RecoveryConfig {
  dueValidation: boolean;
}

/** Accessible ON/OFF switch (no external dependency — a styled button with role=switch). */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span className={cn("inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
      <span className="sr-only">Enable Due Recovery Validation</span>
    </button>
  );
}

/** Settings → Recovery Settings. Currently one global, DB-backed toggle applied to every recovery plan. */
export function RecoveryConfigPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<RecoveryConfig>({
    queryKey: ["recovery-config"],
    queryFn: () => api.get<RecoveryConfig>("/api/settings/recovery-config"),
  });

  const [dueValidation, setDueValidation] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setDueValidation(data.dueValidation);
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => api.put<RecoveryConfig>("/api/settings/recovery-config", { dueValidation }),
    onSuccess: (c) => {
      qc.setQueryData(["recovery-config"], c);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const dirty = !!data && data.dueValidation !== dueValidation;

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader
        title="Recovery Settings"
        subtitle="Global recovery-planning rules. Changes apply immediately to every recovery plan — no deployment needed."
      />

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Enable Due Recovery Validation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start gap-3">
                <Toggle checked={dueValidation} onChange={setDueValidation} />
                <div className="text-sm">
                  <span className="font-medium">{dueValidation ? "ON" : "OFF"}</span>
                  <span className="block text-xs text-muted-foreground">
                    Require Due Recovery Plan to cover Overdue + Due before entering Running Recovery Plan.
                    When OFF, Running Recovery Plan is editable immediately with no threshold check.
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

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
            {saveMut.isError && <span className="text-sm text-destructive">{(saveMut.error as Error).message}</span>}
          </div>
        </>
      )}
    </div>
  );
}
