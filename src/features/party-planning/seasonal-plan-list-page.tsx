"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus } from "lucide-react";
import { api } from "@/lib/api-client";
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import { PartyPlanModeLinks } from "./party-planning-page";
import { OpenButton, SheetStatusBadge, dateTimeText } from "./plan-list-parts";

interface Sheet { id: string; seasonId: string; seasonName: string; seasonOpen: boolean; ownerName: string; status: string; itemCount: number; pendingCount: number; needsMyReview: number; updatedAt: string; own: boolean }
interface SeasonChoice { id: string; name: string; year: number; period: string | null; hasPlan: boolean }

/**
 * Party Planning → Planning → Seasonal: the LIST of Seasonal Plans across all seasons (scope enforced by the API). Nothing here is tied to a
 * "current season": Create asks which open season, and Open loads that exact plan by id.
 */
export function SeasonalPlanListPage({ role }: { role: Role }) {
  const qc = useQueryClient();
  const canPlan = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const canReview = role === Role.REGIONAL_MANAGER || isAdministrativeRole(role);
  const [season, setSeason] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const [creating, setCreating] = useState(false);
  const title = useLabel("party_planning.title");
  const nav = useLabel("party_planning.nav.seasonal");

  const { data: all, isLoading } = useQuery<Sheet[]>({ queryKey: ["seasonal-sheets", season, needsReview], queryFn: () => api.get<Sheet[]>(`/api/seasonal-sheets?${new URLSearchParams({ ...(season ? { season } : {}), ...(needsReview ? { needsReview: "1" } : {}) })}`) });
  const { data: everySheet } = useQuery<Sheet[]>({ queryKey: ["seasonal-sheets", "", false], queryFn: () => api.get<Sheet[]>("/api/seasonal-sheets") });
  const seasonChoices = [...new Map((everySheet ?? []).map((s) => [s.seasonId, s.seasonName])).entries()];
  const showOwner = !canPlan || (all ?? []).some((s) => !s.own);

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: title }, { label: nav }]} title={title}
        subtitle="Your Seasonal Plans — one per season. Open a plan to add its markets." />
      <PartyPlanModeLinks mode="seasonal" />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5"><Label>Season</Label>
            <NativeSelect className="w-48" value={season} placeholder="All seasons" options={seasonChoices.map(([id, name]) => ({ value: id, label: name }))} onChange={(e) => setSeason(e.target.value)} />
          </div>
          {canReview && <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={needsReview} onChange={(e) => setNeedsReview(e.target.checked)} /> Needs my review</label>}
        </div>
        {(canPlan || isAdministrativeRole(role)) && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Create Seasonal Plan</Button>}
      </div>

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Season</TableHead>{showOwner && <TableHead>Officer</TableHead>}<TableHead>Status</TableHead><TableHead>Markets</TableHead><TableHead>Last Saved</TableHead><TableHead className="text-right">Open</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={showOwner ? 6 : 5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : (all?.length ?? 0) === 0 ? <TableRow><TableCell colSpan={showOwner ? 6 : 5} className="py-8 text-center text-muted-foreground">No Seasonal Plans here yet.</TableCell></TableRow>
                : all!.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.seasonName}{!s.seasonOpen && <span className="ml-2 text-xs text-muted-foreground">(closed)</span>}</TableCell>
                    {showOwner && <TableCell>{s.ownerName}</TableCell>}
                    <TableCell><SheetStatusBadge status={s.status} />{s.needsMyReview > 0 && <span className="ml-2 text-xs text-muted-foreground">{s.needsMyReview} to review</span>}</TableCell>
                    <TableCell className="tabular-nums">{s.itemCount}{s.pendingCount > 0 && <span className="text-muted-foreground"> · {s.pendingCount} pending</span>}</TableCell>
                    <TableCell className="text-muted-foreground">{dateTimeText(s.updatedAt)}</TableCell>
                    <TableCell className="text-right"><OpenButton href={`/planning/party/seasonal/${s.id}`} /></TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); qc.invalidateQueries({ queryKey: ["seasonal-sheets"] }); }} />}
    </div>
  );
}

/** Create Seasonal Plan: pick an OPEN season (the Seasons module's rule — all of them, nothing hard-coded). The plan then appears in the list. */
function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [seasonId, setSeasonId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery<{ seasons: SeasonChoice[] }>({ queryKey: ["seasonal-sheet-options"], queryFn: () => api.get("/api/seasonal-sheets/options") });
  const seasons = data?.seasons ?? [];
  const chosen = seasons.find((s) => s.id === seasonId);
  const create = useMutation({ mutationFn: () => api.post("/api/seasonal-sheets", { seasonId }), onSuccess: onCreated, onError: (e) => setError((e as Error).message) });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Create Seasonal Plan</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>Season *</Label>
            <NativeSelect value={seasonId} placeholder={data && seasons.length === 0 ? "No open seasons" : "Select a season…"}
              options={seasons.map((s) => ({ value: s.id, label: `${s.name} ${s.year}${s.hasPlan ? " (plan exists)" : ""}` }))} onChange={(e) => { setSeasonId(e.target.value); setError(null); }} />
            {chosen?.period && <p className="text-xs text-muted-foreground">{chosen.period}</p>}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!seasonId || create.isPending} onClick={() => create.mutate()}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
