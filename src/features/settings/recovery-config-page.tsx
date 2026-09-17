"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
  calendarEnabled: boolean;
}

/** Accessible ON/OFF switch (no external dependency — a styled button with role=switch). */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
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
      <span className="sr-only">{label}</span>
    </button>
  );
}

/** Settings → Recovery Settings. Global DB-backed switches for Recovery validation and Calendar visibility. */
export function RecoveryConfigPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data, isLoading } = useQuery<RecoveryConfig>({
    queryKey: ["recovery-config"],
    queryFn: () => api.get<RecoveryConfig>("/api/settings/recovery-config"),
  });

  const [dueValidation, setDueValidation] = useState(true);
  const [calendarEnabled, setCalendarEnabled] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setDueValidation(data.dueValidation);
      setCalendarEnabled(data.calendarEnabled);
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => api.put<RecoveryConfig>("/api/settings/recovery-config", { dueValidation, calendarEnabled }),
    onSuccess: (c) => {
      qc.setQueryData(["recovery-config"], c);
      qc.invalidateQueries({ queryKey: ["calendar"] });
      qc.invalidateQueries({ queryKey: ["calendar-upcoming"] });
      router.refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const dirty = !!data && (data.dueValidation !== dueValidation || data.calendarEnabled !== calendarEnabled);

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader
        title="Recovery Settings"
        subtitle="Global Recovery and Calendar settings. Changes apply across the system with no deployment needed."
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
                <Toggle checked={dueValidation} onChange={setDueValidation} label="Enable Due Recovery Validation" />
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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Enable Calendar</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start gap-3">
                <Toggle checked={calendarEnabled} onChange={setCalendarEnabled} label="Enable Calendar" />
                <div className="text-sm">
                  <span className="font-medium">{calendarEnabled ? "ON" : "OFF"}</span>
                  <span className="block text-xs text-muted-foreground">
                    Enable the Calendar feature and Calendar-related reminders across the system.
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
