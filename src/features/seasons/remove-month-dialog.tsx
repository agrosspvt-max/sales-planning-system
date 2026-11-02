"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useLabel } from "@/features/labels/label-ui";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface Options {
  source: { id: string; label: string };
  counts: {
    monthlyEntries: number;
    monthlyPlans: number;
    recoveryPlans: number;
    partyMonthlyPlans: number;
    partyMonthlySheets: number;
  };
  targets: { id: string; seasonId: string; label: string }[];
}

export function RemoveMonthDialog({
  seasonId,
  monthId,
  onClose,
  onTransferred,
}: {
  seasonId: string;
  monthId: string;
  onClose: () => void;
  onTransferred: () => void;
}) {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState("");
  const title = useLabel("seasons.remove.title");
  const help = useLabel("seasons.remove.help");
  const destination = useLabel("seasons.remove.destination");
  const none = useLabel("seasons.remove.no_target");
  const confirm = useLabel("seasons.remove.confirm");
  const cancel = useLabel("seasons.remove.cancel");
  const saving = useLabel("seasons.remove.saving");
  const sales = useLabel("seasons.remove.sales");
  const recovery = useLabel("seasons.remove.recovery");
  const party = useLabel("seasons.remove.party");
  const path = `/api/seasons/${seasonId}/months/${monthId}`;
  const { data, isPending, error } = useQuery<Options>({
    queryKey: ["remove-season-month", seasonId, monthId],
    queryFn: () => api.get(path),
    retry: false,
  });
  const targetId = chosen || (data?.targets.length === 1 ? data.targets[0].id : "");
  const mutation = useMutation({
    mutationFn: () => api.del(path, { targetMonthId: targetId }),
    retry: false,
    onSuccess: async () => {
      // Mark cached planning screens stale, but don't fan out refetches for hidden screens.
      await qc.invalidateQueries({ refetchType: "none" });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["seasons"] }),
        qc.invalidateQueries({ queryKey: ["season-months", seasonId] }),
      ]);
      onTransferred();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent
        className="max-w-lg"
        onInteractOutside={(e) => {
          if (mutation.isPending) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (mutation.isPending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {title}
            {data ? ` — ${data.source.label}` : ""}
          </DialogTitle>
          <DialogDescription>{help}</DialogDescription>
        </DialogHeader>
        {isPending ? (
          <Skeleton className="h-32" />
        ) : data ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 rounded-md border p-3 text-sm">
              <div>
                {sales}
                <div className="font-semibold">{data.counts.monthlyEntries}</div>
              </div>
              <div>
                {recovery}
                <div className="font-semibold">{data.counts.recoveryPlans}</div>
              </div>
              <div>
                {party}
                <div className="font-semibold">{data.counts.partyMonthlyPlans}</div>
              </div>
            </div>
            {data.targets.length ? (
              <label className="block space-y-2 text-sm">
                <span>{destination}</span>
                <NativeSelect
                  value={targetId}
                  disabled={mutation.isPending}
                  placeholder={destination}
                  options={data.targets.map((t) => ({ value: t.id, label: t.label }))}
                  onChange={(e) => setChosen(e.target.value)}
                />
              </label>
            ) : (
              <p className="text-sm text-destructive">{none}</p>
            )}
          </div>
        ) : null}
        {(error || mutation.error) && (
          <p role="alert" className="text-sm text-destructive">
            {(mutation.error ?? error)?.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={onClose}>
            {cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={!targetId || !data || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? saving : confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
