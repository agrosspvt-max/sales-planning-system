"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface GroupOpt { id: string; name: string }
interface OfficerOpt { id: string; name: string }
interface Probable { id: string; name: string; reason: string; score: number }
interface CreateResult { dealerId?: string; dealerName?: string; duplicates?: Probable[]; addedToPlan?: boolean; planWarning?: string }

/** The dealer row shape needed to prefill Edit mode (a subset of the Dealer Alias row). */
export interface EditDealer {
  id: string;
  name: string;
  officerId: string | null;
  groupId: string | null;
  town: string | null;
  isActive: boolean;
  aliases: { id: string; tallyName: string }[];
}

/**
 * ONE dealer dialog — Create Mode and Edit Mode. Create reuses POST /api/dealers (the Dealers module
 * service); Edit reuses PATCH /api/dealers/[id] (the Dealers module `editDealer`) for name/territory/
 * officer/status, and DELETE /api/dealer-alias/[id] to remove an alias. Controlled by the caller.
 */
export function DealerDialog({ open, onOpenChange, edit }: { open: boolean; onOpenChange: (o: boolean) => void; edit?: EditDealer | null }) {
  const qc = useQueryClient();
  const isEdit = !!edit;
  const [name, setName] = useState("");
  const [aliasName, setAliasName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [officerId, setOfficerId] = useState("");
  const [town, setTown] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [addToPlan, setAddToPlan] = useState(false);
  const [phase, setPhase] = useState<"form" | "duplicates">("form");
  const [duplicates, setDuplicates] = useState<Probable[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Prefill on open (Edit) or reset (Create).
  useEffect(() => {
    if (!open) return;
    setName(edit?.name ?? "");
    setAliasName("");
    setGroupId(edit?.groupId ?? "");
    setOfficerId(edit?.officerId ?? "");
    setTown(edit?.town ?? "");
    setIsActive(edit?.isActive ?? true);
    setAddToPlan(false);
    setPhase("form");
    setDuplicates([]);
    setError(null);
  }, [open, edit]);

  const { data: groups } = useQuery<GroupOpt[]>({ queryKey: ["groups"], queryFn: () => api.get("/api/groups"), enabled: open });
  const { data: officers } = useQuery<OfficerOpt[]>({
    queryKey: ["officers", groupId],
    queryFn: () => api.get(`/api/users/officers${groupId ? `?groupId=${groupId}` : ""}`),
    enabled: open && !!groupId, // officer dropdown loads only after a group is chosen
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["dealer-coverage"] });
    qc.invalidateQueries({ queryKey: ["dealer-alias"] });
    qc.invalidateQueries({ queryKey: ["group-product-plan"] });
  };
  const close = () => onOpenChange(false);

  const submit = useMutation({
    mutationFn: (force?: boolean) => {
      if (isEdit && edit) {
        return api.patch<CreateResult>(`/api/dealers/${edit.id}`, {
          name: name.trim(), alias: aliasName.trim() || undefined, officerId, groupId, town: town.trim() || undefined, isActive,
        });
      }
      return api.post<CreateResult>("/api/dealers", {
        name: name.trim(), aliasName: aliasName.trim(), officerId, groupId, town: town.trim() || undefined, addToSeasonalPlan: addToPlan, force,
      });
    },
    onSuccess: (r) => {
      if (r?.duplicates && r.duplicates.length > 0) { setDuplicates(r.duplicates); setPhase("duplicates"); return; }
      invalidate();
      close();
    },
    onError: (e) => setError((e as Error).message),
  });
  const assignExisting = useMutation({
    mutationFn: (dealerId: string) => api.post("/api/dealers/assign", { dealerId, officerId }),
    onSuccess: () => { invalidate(); close(); },
    onError: (e) => setError((e as Error).message),
  });
  const removeAlias = useMutation({
    mutationFn: (id: string) => api.del(`/api/dealer-alias/${id}`),
    onSuccess: () => invalidate(),
    onError: (e) => setError((e as Error).message),
  });

  // Create requires an alias; Edit does not (alias is optional / removable).
  const canSubmit = name.trim() && groupId && officerId && (isEdit || aliasName.trim()) && !submit.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh]">
        <DialogHeader><DialogTitle>{phase === "duplicates" ? "Possible Existing Dealer" : isEdit ? "Edit Dealer" : "Create Dealer"}</DialogTitle></DialogHeader>

        {phase === "form" ? (
          <div className="space-y-3 overflow-y-auto">
            {!isEdit && <p className="text-xs text-muted-foreground">Created ACTIVE, assigned to the selected officer, and aliased immediately — no approval required.</p>}
            <div className="space-y-1.5"><Label>Dealer Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Required" /></div>
            <div className="space-y-1.5">
              <Label>Dealer Alias (Tally Name){isEdit ? "" : " *"}</Label>
              <Input value={aliasName} onChange={(e) => setAliasName(e.target.value)} placeholder={isEdit ? "Add another Tally alias (optional)" : "The Tally name to match on"} />
            </div>

            {/* Existing aliases (Edit) — remove after confirmation; Sales Upload falls back to exact matching if none remain. */}
            {isEdit && edit && edit.aliases.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Current aliases</Label>
                <div className="flex flex-wrap gap-1">
                  {edit.aliases.map((a) => (
                    <span key={a.id} className="inline-flex items-center gap-1 rounded-md border bg-muted/30 px-2 py-0.5 text-xs">
                      {a.tallyName}
                      <button
                        type="button"
                        className="text-destructive hover:opacity-70"
                        title="Remove alias"
                        disabled={removeAlias.isPending}
                        onClick={() => { if (window.confirm(`Remove alias "${a.tallyName}"? Sales Upload will fall back to exact dealer matching.`)) removeAlias.mutate(a.id); }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Group *</Label>
                <NativeSelect value={groupId} onChange={(e) => { setGroupId(e.target.value); setOfficerId(""); }} options={[{ value: "", label: "Select a group…" }, ...(groups ?? []).map((g) => ({ value: g.id, label: g.name }))]} />
              </div>
              <div className="space-y-1.5">
                <Label>Sales Officer *</Label>
                <NativeSelect value={officerId} disabled={!groupId} onChange={(e) => setOfficerId(e.target.value)} options={[{ value: "", label: groupId ? "Select an officer…" : "Select a group first" }, ...(officers ?? []).map((o) => ({ value: o.id, label: o.name }))]} />
              </div>
            </div>
            <div className="space-y-1.5"><Label>Territory</Label><Input value={town} onChange={(e) => setTown(e.target.value)} placeholder="Optional" /></div>

            {isEdit ? (
              <div className="space-y-1.5">
                <Label>Status</Label>
                <div className="flex items-center gap-4 text-sm">
                  <label className="flex items-center gap-1.5"><input type="radio" name="dealer-status" checked={isActive} onChange={() => setIsActive(true)} /> Active</label>
                  <label className="flex items-center gap-1.5"><input type="radio" name="dealer-status" checked={!isActive} onChange={() => setIsActive(false)} /> Inactive</label>
                </div>
                {!isActive && <p className="text-xs text-warning">Inactive dealers disappear from active dropdowns and can’t be added to new plans, but stay in historical plans, recovery and reports.</p>}
              </div>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={addToPlan} onChange={(e) => setAddToPlan(e.target.checked)} />
                Automatically add this dealer to the officer&apos;s Active Seasonal Plan
              </label>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button onClick={() => { setError(null); submit.mutate(undefined); }} disabled={!canSubmit}>
                {submit.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : isEdit ? "Save changes" : "Continue"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <span>A dealer like “{name}” may already exist. Review before creating a duplicate.</span>
            </div>
            <ul className="space-y-1">
              {duplicates.map((d) => (
                <li key={d.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
                  <span>{d.name} <Badge variant="muted" className="ml-1 text-[10px]">{d.reason}</Badge></span>
                  <Button size="sm" variant="outline" disabled={assignExisting.isPending} onClick={() => assignExisting.mutate(d.id)}>Assign this dealer</Button>
                </li>
              ))}
            </ul>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setPhase("form")}>Back</Button>
              <Button variant="destructive" onClick={() => { setError(null); submit.mutate(true); }} disabled={submit.isPending}>
                {submit.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</> : "Create anyway"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
