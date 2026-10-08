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

interface Sheet { id: string; seasonId: string; seasonName: string; seasonOpen: boolean; monthLabel: string; ownerName: string; status: string; itemCount: number; needsMyAction: number; updatedAt: string; own: boolean }
interface MonthChoice { id: string; label: string }
interface SeasonChoice { id: string; name: string; year: number; period: string | null; months: MonthChoice[]; eligibleCount: number; takenMonthIds: string[] }

/**
 * Party Planning → Planning → Monthly: the LIST of Monthly Plans across all seasons and months (scope enforced by the API). Create asks for a
 * Season and one of ITS months; Open loads that exact plan by id. Nothing is tied to a "current season" or "current month".
 */
export function MonthlyPlanListPage({ role }: { role: Role }) {
  const qc = useQueryClient();
  const canPlan = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const canAct = canPlan || isAdministrativeRole(role);
  const [season, setSeason] = useState("");
  const [needsAction, setNeedsAction] = useState(false);
  const [creating, setCreating] = useState(false);
  const title = useLabel("party_planning.title");
  const nav = useLabel("party_planning.nav.monthly");

  const { data: all, isLoading } = useQuery<Sheet[]>({ queryKey: ["party-monthly-sheets", season, needsAction], queryFn: () => api.get<Sheet[]>(`/api/party-monthly-sheets?${new URLSearchParams({ ...(season ? { season } : {}), ...(needsAction ? { needsAction: "1" } : {}) })}`) });
  const { data: everySheet } = useQuery<Sheet[]>({ queryKey: ["party-monthly-sheets", "", false], queryFn: () => api.get<Sheet[]>("/api/party-monthly-sheets") });
  const seasonChoices = [...new Map((everySheet ?? []).map((s) => [s.seasonId, s.seasonName])).entries()];
  const showOwner = !canPlan || (all ?? []).some((s) => !s.own);

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: title }, { label: nav }]} title={title}
        subtitle="Your Monthly Plans — one per season month. Open a plan to plan the parties for each market." />
      <PartyPlanModeLinks mode="monthly" />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5"><Label>Season</Label>
            <NativeSelect className="w-48" value={season} placeholder="All seasons" options={seasonChoices.map(([id, name]) => ({ value: id, label: name }))} onChange={(e) => setSeason(e.target.value)} />
          </div>
          {canAct && <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={needsAction} onChange={(e) => setNeedsAction(e.target.checked)} /> Needs my action</label>}
        </div>
        {(canPlan || isAdministrativeRole(role)) && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Create Monthly Plan</Button>}
      </div>

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Season</TableHead><TableHead>Month</TableHead>{showOwner && <TableHead>Officer</TableHead>}<TableHead>Status</TableHead><TableHead>Markets</TableHead><TableHead>Last Saved</TableHead><TableHead className="text-right">Open</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={showOwner ? 7 : 6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : (all?.length ?? 0) === 0 ? <TableRow><TableCell colSpan={showOwner ? 7 : 6} className="py-8 text-center text-muted-foreground">No Monthly Plans here yet.</TableCell></TableRow>
                : all!.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.seasonName}{!s.seasonOpen && <span className="ml-2 text-xs text-muted-foreground">(closed)</span>}</TableCell>
                    <TableCell className="whitespace-nowrap">{s.monthLabel}</TableCell>
                    {showOwner && <TableCell>{s.ownerName}</TableCell>}
                    <TableCell><SheetStatusBadge status={s.status} />{s.needsMyAction > 0 && <span className="ml-2 text-xs text-muted-foreground">{s.needsMyAction} to action</span>}</TableCell>
                    <TableCell className="tabular-nums">{s.itemCount}</TableCell>
                    <TableCell className="text-muted-foreground">{dateTimeText(s.updatedAt)}</TableCell>
                    <TableCell className="text-right"><OpenButton href={`/planning/party/monthly/${s.id}`} /></TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); qc.invalidateQueries({ queryKey: ["party-monthly-sheets"] }); qc.invalidateQueries({ queryKey: ["party-monthly-sheet-options"] }); }} />}
    </div>
  );
}

/** Create Monthly Plan: an OPEN season, then one of ITS months (calendar order). A season without an approved Seasonal Plan market is explained, not silently accepted. */
function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [seasonId, setSeasonId] = useState("");
  const [monthId, setMonthId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery<{ seasons: SeasonChoice[] }>({ queryKey: ["party-monthly-sheet-options"], queryFn: () => api.get("/api/party-monthly-sheets/options") });
  const seasons = data?.seasons ?? [];
  const chosen = seasons.find((s) => s.id === seasonId);
  const noMarkets = chosen != null && chosen.eligibleCount === 0;
  const create = useMutation({ mutationFn: () => api.post("/api/party-monthly-sheets", { seasonId, seasonMonthId: monthId }), onSuccess: onCreated, onError: (e) => setError((e as Error).message) });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Create Monthly Plan</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>Season *</Label>
            <NativeSelect value={seasonId} placeholder={data && seasons.length === 0 ? "No open seasons" : "Select a season…"}
              options={seasons.map((s) => ({ value: s.id, label: `${s.name} ${s.year}` }))} onChange={(e) => { setSeasonId(e.target.value); setMonthId(""); setError(null); }} />
            {chosen?.period && <p className="text-xs text-muted-foreground">{chosen.period}</p>}
          </div>
          <div className="space-y-1.5"><Label>Month *</Label>
            <NativeSelect value={monthId} disabled={!chosen} placeholder="Select a month…"
              options={(chosen?.months ?? []).map((m) => ({ value: m.id, label: m.label + (chosen!.takenMonthIds.includes(m.id) ? " (plan exists)" : "") }))} onChange={(e) => { setMonthId(e.target.value); setError(null); }} />
          </div>
          {noMarkets && <p className="text-sm text-destructive">You have no approved Seasonal Plan market in {chosen!.name} {chosen!.year}. Get a Seasonal Plan approved first, then create the Monthly Plan.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!seasonId || !monthId || noMarkets || create.isPending} onClick={() => create.mutate()}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
