"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface DealerFields {
  name: string;
  mobile?: string;
  village?: string;
  tehsil?: string;
  district?: string;
  address?: string;
}
interface Probable { id: string; name: string; reason: string; score: number }

type Ctx =
  | { variant: "monthly"; monthlyPlanId: string; dealerId?: string } // dealerId => edit mode
  | { variant: "admin"; officerId: string };

/**
 * The ONE Create/Edit Dealer dialog, reused by Monthly Planning (Sales Officer) and the Sales
 * Officer's User Details page (Admin). Shows a "Possible Existing Dealer" step before creating,
 * so a near-duplicate is a decision, not a silent new record.
 */
export function DealerFormDialog({
  open,
  onOpenChange,
  ctx,
  initial,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ctx: Ctx;
  initial?: DealerFields;
  onDone: (dealerId?: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open && <DealerFormBody ctx={ctx} initial={initial} onClose={() => onOpenChange(false)} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Create/Edit Dealer form itself (header + duplicate-check flow + submit), WITHOUT the surrounding
 * Dialog — so it can live either in its own dialog (`DealerFormDialog`) or as a tab inside the Monthly
 * "Add Dealer" modal, reusing the exact same creation logic and duplicate guard.
 */
export function DealerFormBody({
  ctx,
  initial,
  onClose,
  onDone,
}: {
  ctx: Ctx;
  initial?: DealerFields;
  onClose: () => void;
  onDone: (dealerId?: string) => void;
}) {
  const qc = useQueryClient();
  const isEdit = ctx.variant === "monthly" && !!ctx.dealerId;
  const [form, setForm] = useState<DealerFields>({ name: "" });
  const [phase, setPhase] = useState<"form" | "duplicates">("form");
  const [duplicates, setDuplicates] = useState<Probable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof DealerFields, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Reset when (re)mounted or the initial values change — the body only renders while its dialog/tab is open.
  useEffect(() => {
    setForm(initial ?? { name: "" }); setPhase("form"); setDuplicates([]); setError(null);
  }, [initial]);

  const invalidate = () => {
    if (ctx.variant === "monthly") qc.invalidateQueries({ queryKey: ["monthly-plan", ctx.monthlyPlanId] });
    qc.invalidateQueries({ queryKey: ["dealer-coverage"] });
  };

  const submit = useMutation({
    mutationFn: (force?: boolean) => {
      const body = { ...form, force };
      if (ctx.variant === "monthly") {
        return ctx.dealerId
          ? api.patch(`/api/planning/monthly-plans/${ctx.monthlyPlanId}/dealers/${ctx.dealerId}`, body)
          : api.post(`/api/planning/monthly-plans/${ctx.monthlyPlanId}/dealers`, body);
      }
      return api.post("/api/dealers", { ...body, officerId: ctx.officerId });
    },
    onSuccess: (res: unknown) => {
      const r = res as { dealerId?: string; duplicates?: Probable[] };
      if (r.duplicates && r.duplicates.length > 0) { setDuplicates(r.duplicates); setPhase("duplicates"); return; }
      invalidate();
      onClose();
      onDone(r.dealerId);
    },
    onError: (e) => setError((e as Error).message),
  });

  const assignExisting = useMutation({
    mutationFn: (dealerId: string) => api.post("/api/dealers/assign", { dealerId, officerId: (ctx as { officerId: string }).officerId }),
    onSuccess: () => { invalidate(); onClose(); onDone(); },
    onError: (e) => setError((e as Error).message),
  });

  const title = isEdit ? "Edit Dealer" : "Create Dealer";

  return (
    <>
        <DialogHeader><DialogTitle>{phase === "form" ? title : "Possible Existing Dealer"}</DialogTitle></DialogHeader>

        {phase === "form" ? (
          <div className="space-y-3">
            {ctx.variant === "admin" && <p className="text-xs text-muted-foreground">Created ACTIVE and assigned to this officer immediately — no approval required.</p>}
            {ctx.variant === "monthly" && !isEdit && <p className="text-xs text-muted-foreground">Pending until this Monthly Plan is approved; visible only in your plan until then.</p>}
            <div className="space-y-1.5">
              <Label>Dealer Name *</Label>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Required" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Mobile</Label><Input value={form.mobile ?? ""} onChange={(e) => set("mobile", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Village</Label><Input value={form.village ?? ""} onChange={(e) => set("village", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Tehsil</Label><Input value={form.tehsil ?? ""} onChange={(e) => set("tehsil", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>District</Label><Input value={form.district ?? ""} onChange={(e) => set("district", e.target.value)} /></div>
            </div>
            <div className="space-y-1.5"><Label>Address</Label><Input value={form.address ?? ""} onChange={(e) => set("address", e.target.value)} /></div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={() => submit.mutate(undefined)} disabled={!form.name.trim() || submit.isPending}>
                {submit.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : isEdit ? "Save changes" : "Continue"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <span>A dealer like “{form.name}” may already exist. Review before creating a duplicate.</span>
            </div>
            <ul className="space-y-1">
              {duplicates.map((d) => (
                <li key={d.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
                  <span>{d.name} <Badge variant="muted" className="ml-1 text-[10px]">{d.reason}</Badge></span>
                  {ctx.variant === "admin" && (
                    <Button size="sm" variant="outline" disabled={assignExisting.isPending} onClick={() => assignExisting.mutate(d.id)}>Assign this dealer</Button>
                  )}
                </li>
              ))}
            </ul>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setPhase("form")}>Back</Button>
              <Button variant="destructive" onClick={() => submit.mutate(true)} disabled={submit.isPending}>
                {submit.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</> : "Create anyway"}
              </Button>
            </DialogFooter>
          </div>
        )}
    </>
  );
}
