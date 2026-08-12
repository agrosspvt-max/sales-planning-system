"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface SeasonPlanOption { id: string; version: number; status: string; planningType: string; isActiveVersion: boolean; createdAt: string }
interface TransferOptions { recoveryPlanId: string; officerId: string; seasonId: string; current: SeasonPlanOption | null; targets: SeasonPlanOption[] }

const label = (p: SeasonPlanOption) => `Version ${p.version} (${p.status})`;

/**
 * Super-Admin-only "Transfer Recovery Plan" action. Self-contained: it fetches its own eligible targets
 * (same officer & season) and moves ONLY the RecoveryPlan→SeasonPlan relation. No recovery data changes.
 */
export function TransferRecoveryPlan({ id }: { id: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<TransferOptions>({
    queryKey: ["recovery-transfer-options", id],
    queryFn: () => api.get(`/api/recovery/plans/${id}/transfer`),
    enabled: open,
  });

  const targets = data?.targets ?? [];
  const single = targets.length === 1 ? targets[0] : null;
  const selectedId = single ? single.id : choice;
  const selected = targets.find((t) => t.id === selectedId) ?? null;

  const transfer = useMutation({
    mutationFn: () => api.post(`/api/recovery/plans/${id}/transfer`, { targetSeasonPlanId: selectedId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recovery-plan", id] });
      qc.invalidateQueries({ queryKey: ["recovery-plans"] });
      qc.invalidateQueries({ queryKey: ["recovery-transfer-options", id] });
      close();
    },
    onError: (e) => setError((e as Error).message),
  });

  function close() {
    setOpen(false);
    setChoice("");
    setError(null);
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ArrowRightLeft className="h-4 w-4" /> Transfer Recovery Plan
      </Button>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent>
          <DialogHeader><DialogTitle>Transfer Recovery Plan</DialogTitle></DialogHeader>

          {isLoading || !data ? (
            <Skeleton className="h-28 w-full" />
          ) : (
            <div className="space-y-4 text-sm">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Current Seasonal Plan</p>
                {data.current ? (
                  <div className="flex items-center gap-2">
                    <span className="font-medium">Version {data.current.version}</span>
                    <Badge variant="secondary">{data.current.status}</Badge>
                    <span className="text-muted-foreground">Created {formatDate(data.current.createdAt)}</span>
                  </div>
                ) : (
                  <p className="text-muted-foreground">Not attached to any Seasonal Plan.</p>
                )}
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Transfer To</p>
                {targets.length === 0 ? (
                  <p className="text-muted-foreground">No other Seasonal Plan exists for this Sales Officer and season.</p>
                ) : single ? (
                  <div className="flex items-center gap-2">
                    <span className="font-medium">Version {single.version}</span>
                    <Badge variant="secondary">{single.status}</Badge>
                    <span className="text-muted-foreground">Created {formatDate(single.createdAt)}</span>
                  </div>
                ) : (
                  <NativeSelect
                    className="w-full"
                    placeholder="Choose a Seasonal Plan…"
                    value={choice}
                    onChange={(e) => setChoice(e.target.value)}
                    options={targets.map((t) => ({ value: t.id, label: `${label(t)} · Created ${formatDate(t.createdAt)}` }))}
                  />
                )}
              </div>

              {selected && (
                <p className="rounded-md border border-dashed bg-muted/30 p-2 text-xs text-muted-foreground">
                  This will attach this Recovery Plan to Seasonal Plan Version {selected.version}. No recovery data will be modified.
                </p>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button onClick={() => { setError(null); transfer.mutate(); }} disabled={!selectedId || transfer.isPending}>
              Confirm Transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
