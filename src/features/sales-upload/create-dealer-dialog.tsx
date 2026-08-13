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
import { DEALER_STATUSES, type DealerStatus } from "@/lib/dealer-status";

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
  status: string; // PENDING | ACTIVE | INACTIVE | DEFAULTER
  inActivePlan: boolean; // already a member of the owning officer's active seasonal plan (via PlanDealer)
  aliases: { id: string; tallyName: string }[];
}

const STATUS_OPTIONS: { value: DealerStatus; label: string; note?: string }[] = [
  { value: "PENDING", label: "Pending", note: "Awaiting approval. Participates in uploads, matching and recovery, but is not eligible for planning until set Active." },
  { value: "ACTIVE", label: "Active", note: "Fully eligible everywhere, including planning." },
  { value: "INACTIVE", label: "Inactive", note: "Hidden from active dropdowns and new plans; stays in historical plans, recovery and reports." },
  { value: "DEFAULTER", label: "Defaulter", note: "Blocked from every planning screen (Dealer Plan, Product Summary, Territory Plan/Recovery). Uploads, recovery history, reports and audit are unaffected." },
];

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
  const [status, setStatus] = useState<DealerStatus>("ACTIVE");
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
    const s = (DEALER_STATUSES as readonly string[]).includes(edit?.status ?? "") ? (edit!.status as DealerStatus) : "ACTIVE";
    setStatus(s);
    // Create defaults ON (new dealers usually participate in planning); Edit reflects current membership.
    setAddToPlan(edit ? edit.inActivePlan : true);
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
          name: name.trim(), alias: aliasName.trim() || undefined, officerId, groupId, town: town.trim() || undefined, status, addToSeasonalPlan: addToPlan,
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

            {isEdit && (
              <div className="space-y-1.5">
                <Label>Status</Label>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
                  {STATUS_OPTIONS.map((o) => (
                    <label key={o.value} className="flex items-center gap-1.5">
                      <input type="radio" name="dealer-status" checked={status === o.value} onChange={() => setStatus(o.value)} /> {o.label}
                    </label>
                  ))}
                </div>
                {STATUS_OPTIONS.find((o) => o.value === status)?.note && (
                  <p className={`text-xs ${status === "ACTIVE" ? "text-muted-foreground" : "text-warning"}`}>
                    {STATUS_OPTIONS.find((o) => o.value === status)!.note}
                  </p>
                )}
              </div>
            )}

            {/* Active Seasonal Plan membership. Create: default ON. Edit: reflects current membership and
                is DISABLED once already included (removal is a separate workflow) or when the dealer is not
                Active (only Active dealers are plan-eligible). */}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={addToPlan && (!isEdit || status === "ACTIVE")}
                disabled={isEdit && (!!edit?.inActivePlan || status !== "ACTIVE")}
                onChange={(e) => setAddToPlan(e.target.checked)}
              />
              <span>
                Automatically add this dealer to the officer&apos;s Active Seasonal Plan
                {isEdit && edit?.inActivePlan && <span className="mt-0.5 block text-xs text-muted-foreground">Already included in the Active Seasonal Plan.</span>}
                {isEdit && !edit?.inActivePlan && status !== "ACTIVE" && <span className="mt-0.5 block text-xs text-muted-foreground">Only Active dealers can be added to a plan.</span>}
              </span>
            </label>

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
