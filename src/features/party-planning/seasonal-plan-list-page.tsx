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
import { OpenButton, SheetStatusBadge, dateTimeText, stageCount, stageStatusLabel } from "./plan-list-parts";
import { sheetInStage, type PlanStage } from "@/lib/monthly-plan";
import { fill, useLabels } from "./party-labels";

interface Sheet { id: string; seasonId: string; seasonName: string; seasonOpen: boolean; ownerName: string; status: string; itemCount: number; pendingCount: number; needsMyReview: number; updatedAt: string; own: boolean; counts: { create: number; submitted: number; approved: number } }
interface SeasonChoice { id: string; name: string; year: number; period: string | null; hasPlan: boolean }

/**
 * Party Planning → Planning → Seasonal: the LIST of Seasonal Plans across all seasons (scope enforced by the API). Nothing here is tied to a
 * "current season": Create asks which open season, and Open loads that exact plan by id.
 */
export function SeasonalPlanListPage({ role, stage = "create" }: { role: Role; stage?: PlanStage }) {
  const qc = useQueryClient();
  const canPlan = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const [creating, setCreating] = useState(false);
  const title = useLabel("party_planning.title");
  const nav = useLabel("party_planning.nav.seasonal");
  const T = useLabels({ planning: "party_planning.crumb.planning", createView: "party_planning.crumb.create_view", subtitle: "party_planning.seasonal.subtitle_list", createPlan: "party_planning.seasonal.action.create_plan",
    season: "party_planning.common.season", officer: "party_planning.common.officer", status: "party_planning.seasonal.col.status", markets: "party_planning.common.markets", lastSaved: "party_planning.common.last_saved", open: "party_planning.common.open",
    closed: "party_planning.common.closed", toReview: "party_planning.seasonal.msg.to_review", emptyCreate: "party_planning.seasonal.empty_create", emptyOlder: "party_planning.seasonal.empty_older", emptySubmitted: "party_planning.seasonal.empty_submitted", emptyApproved: "party_planning.seasonal.empty_approved" });

  const { data: everyInScope, isLoading } = useQuery<Sheet[]>({ queryKey: ["seasonal-sheets"], queryFn: () => api.get<Sheet[]>("/api/seasonal-sheets") });
  // ONE row per logical plan (owner + season): Create always lists it while the season is open (entries can be added at any time); Submitted / Approved list it while it holds such entries; a closed season → Older Plans.
  const all = everyInScope?.filter((s) => sheetInStage(s.counts, s.seasonOpen, stage));
  const showOwner = !canPlan || (all ?? []).some((s) => !s.own);

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: T.planning }, { label: T.createView, href: "/planning/create" }, { label: title }, { label: nav }]} title={title}
        subtitle={T.subtitle} />
      <PartyPlanModeLinks mode="seasonal" stage={stage}
        actions={stage === "create" && (canPlan || isAdministrativeRole(role)) ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {T.createPlan}</Button> : undefined} />

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{T.season}</TableHead>{showOwner && <TableHead>{T.officer}</TableHead>}<TableHead>{T.status}</TableHead><TableHead>{T.markets}</TableHead><TableHead>{T.lastSaved}</TableHead><TableHead className="text-right">{T.open}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={showOwner ? 6 : 5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : (all?.length ?? 0) === 0 ? <TableRow><TableCell colSpan={showOwner ? 6 : 5} className="py-8 text-center text-muted-foreground">{stage === "create" ? T.emptyCreate : stage === "older" ? T.emptyOlder : stage === "submitted" ? T.emptySubmitted : T.emptyApproved}</TableCell></TableRow>
                : all!.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.seasonName}{!s.seasonOpen && <span className="ml-2 text-xs text-muted-foreground">{T.closed}</span>}</TableCell>
                    {showOwner && <TableCell>{s.ownerName}</TableCell>}
                    <TableCell><SheetStatusBadge status={stageStatusLabel(s.counts, stage)} />{s.needsMyReview > 0 && <span className="ml-2 text-xs text-muted-foreground">{fill(T.toReview, { count: s.needsMyReview })}</span>}</TableCell>
                    <TableCell className="tabular-nums">{stageCount(s.counts, s.itemCount, stage)}</TableCell>
                    <TableCell className="text-muted-foreground">{dateTimeText(s.updatedAt)}</TableCell>
                    <TableCell className="text-right"><OpenButton href={`/planning/party/seasonal/${s.id}?stage=${stage}`} /></TableCell>
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
  const T = useLabels({ title: "party_planning.seasonal.action.create_plan", season: "party_planning.common.season", noOpen: "party_planning.common.no_open_seasons", select: "party_planning.common.select_season", exists: "party_planning.common.plan_exists", cancel: "party_planning.common.cancel", create: "party_planning.common.create" });
  const { data } = useQuery<{ seasons: SeasonChoice[] }>({ queryKey: ["seasonal-sheet-options"], queryFn: () => api.get("/api/seasonal-sheets/options") });
  const seasons = data?.seasons ?? [];
  const chosen = seasons.find((s) => s.id === seasonId);
  const create = useMutation({ mutationFn: () => api.post("/api/seasonal-sheets", { seasonId }), onSuccess: onCreated, onError: (e) => setError((e as Error).message) });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>{T.season} *</Label>
            <NativeSelect value={seasonId} placeholder={data && seasons.length === 0 ? T.noOpen : T.select}
              options={seasons.map((s) => ({ value: s.id, label: `${s.name} ${s.year}${s.hasPlan ? ` ${T.exists}` : ""}` }))} onChange={(e) => { setSeasonId(e.target.value); setError(null); }} />
            {chosen?.period && <p className="text-xs text-muted-foreground">{chosen.period}</p>}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{T.cancel}</Button>
          <Button disabled={!seasonId || create.isPending} onClick={() => create.mutate()}>{T.create}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
