"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import { defaultMonthlySelection, monthIdForKey, type PlanStage } from "@/lib/monthly-plan";
import { fill, useLabels } from "./party-labels";
import { OpenButton, SheetStatusBadge, dateTimeText, stageCount, stageStatusLabel } from "./plan-list-parts";

interface Sheet { id: string; seasonId: string; seasonName: string; seasonOpen: boolean; monthLabel: string; ownerName: string; status: string; counts: { create: number; submitted: number; approved: number; pendingRm: number; rejected: number }; submittedAt: string | null; itemCount: number; needsMyAction: number; updatedAt: string; own: boolean }
interface MonthChoice { id: string; label: string; key: string }
interface SeasonChoice { id: string; name: string; year: number; period: string | null; months: MonthChoice[]; eligibleCount: number; takenMonthIds: string[] }

/**
 * Party Planning → Planning → Monthly: the LIST of Monthly Plans across all seasons and months (scope enforced by the API). Create asks for a
 * Season and one of ITS months; Open loads that exact plan by id. Nothing is tied to a "current season" or "current month".
 */
export function MonthlyPlanListPage({ role, stage = "create" }: { role: Role; stage?: PlanStage }) {
  const qc = useQueryClient();
  const router = useRouter();
  const canPlan = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const [creating, setCreating] = useState(false);
  const title = useLabel("party_planning.title");
  const nav = useLabel("party_planning.nav.monthly");
  const T = useLabels({ planning: "party_planning.crumb.planning", crumbCreate: "party_planning.crumb.create_new_plan", crumbView: "party_planning.crumb.view_plans", subtitleView: "party_planning.monthly.subtitle_list_view", createView: "party_planning.crumb.create_view", subtitle: "party_planning.monthly.subtitle_list", createPlan: "party_planning.monthly.action.create_plan",
    season: "party_planning.common.season", month: "party_planning.monthly.col.month", officer: "party_planning.common.officer", overall: "party_planning.monthly.col.overall_status", markets: "party_planning.common.markets", lastSaved: "party_planning.common.last_saved",
    submittedLastSaved: "party_planning.monthly.col.submitted_last_saved", open: "party_planning.common.open", closed: "party_planning.common.closed", toAction: "party_planning.monthly.msg.to_action",
    emptyCreate: "party_planning.monthly.empty_create", emptyOlder: "party_planning.monthly.empty_older", emptySubmitted: "party_planning.monthly.empty_submitted", emptyApproved: "party_planning.monthly.empty_approved" });

  const { data: all, isLoading } = useQuery<Sheet[]>({ queryKey: ["party-monthly-sheets", stage], queryFn: () => api.get<Sheet[]>(`/api/party-monthly-sheets?${new URLSearchParams({ stage })}`) });
  const showOwner = !canPlan || (all ?? []).some((s) => !s.own);

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: T.planning }, { label: T.createView, href: "/planning/create" }, { label: title }, { label: nav }, { label: stage === "create" ? T.crumbCreate : T.crumbView }]} title={title}
        subtitle={stage === "create" ? T.subtitle : T.subtitleView} />
      <PartyPlanModeLinks mode="monthly" stage={stage}
        actions={stage === "create" && (canPlan || isAdministrativeRole(role)) ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {T.createPlan}</Button> : undefined} />

      <div className="overflow-auto rounded-lg border bg-background">
        <Table numbered>
          <TableHeader><TableRow>
            <TableHead>{T.season}</TableHead><TableHead>{T.month}</TableHead>{showOwner && <TableHead>{T.officer}</TableHead>}<TableHead>{T.overall}</TableHead><TableHead>{T.markets}</TableHead><TableHead>{stage === "create" || stage === "older" ? T.lastSaved : T.submittedLastSaved}</TableHead><TableHead className="text-right">{T.open}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={showOwner ? 7 : 6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : (all?.length ?? 0) === 0 ? <TableRow><TableCell colSpan={showOwner ? 7 : 6} className="py-8 text-center text-muted-foreground">{stage === "create" ? T.emptyCreate : stage === "older" ? T.emptyOlder : stage === "submitted" ? T.emptySubmitted : T.emptyApproved}</TableCell></TableRow>
                : all!.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.seasonName}{!s.seasonOpen && <span className="ml-2 text-xs text-muted-foreground">{T.closed}</span>}</TableCell>
                    <TableCell className="whitespace-nowrap">{s.monthLabel}</TableCell>
                    {showOwner && <TableCell>{s.ownerName}</TableCell>}
                    <TableCell><SheetStatusBadge status={stageStatusLabel(s.counts, stage)} />{s.needsMyAction > 0 && <span className="ml-2 text-xs text-muted-foreground">{fill(T.toAction, { count: s.needsMyAction })}</span>}</TableCell>
                    <TableCell className="tabular-nums">{stageCount(s.counts, s.itemCount, stage)}</TableCell>
                    <TableCell className="text-muted-foreground">{dateTimeText(stage === "submitted" ? s.submittedAt ?? s.updatedAt : s.updatedAt)}</TableCell>
                    <TableCell className="text-right"><OpenButton href={`/planning/party/monthly/${s.id}?stage=${stage}`} /></TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); qc.invalidateQueries({ queryKey: ["party-monthly-sheets"] }); qc.invalidateQueries({ queryKey: ["party-monthly-sheet-options"] }); router.push(`/planning/party/monthly/${id}?stage=create`); }} />}
    </div>
  );
}

/**
 * Create Monthly Plan: an OPEN season, then one of ITS months (calendar order), pre-selected with the running calendar month of the one season that has approved markets (suggestions only —
 * both stay changeable and the user still clicks Create). Create opens the month's editor at once; an existing month is reopened. A season without an approved Seasonal Plan market is explained.
 */
function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (sheetId: string) => void }) {
  // null = the user has not touched the field yet, so the suggested default (computed ONCE, when the options first arrive) applies.
  const [pickedSeason, setSeasonId] = useState<string | null>(null);
  const [pickedMonth, setMonthId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const T = useLabels({ title: "party_planning.monthly.action.create_plan", season: "party_planning.common.season", month: "party_planning.monthly.col.month", noOpen: "party_planning.common.no_open_seasons", select: "party_planning.common.select_season",
    selectMonth: "party_planning.monthly.placeholder.select_month", exists: "party_planning.monthly.msg.continue_existing", noCurrent: "party_planning.monthly.msg.no_current_match", noMarkets: "party_planning.monthly.msg.no_approved_markets", cancel: "party_planning.common.cancel", create: "party_planning.common.create" });
  const { data } = useQuery<{ seasons: SeasonChoice[]; currentMonthKey: string }>({ queryKey: ["party-monthly-sheet-options"], queryFn: () => api.get("/api/party-monthly-sheets/options") });
  // Defaults are computed ONCE, when the options first arrive; a background refetch never overwrites what the user has chosen.
  const suggested = useRef<{ seasonId: string; monthId: string; noMatch: boolean } | null>(null);
  if (data && !suggested.current) {
    suggested.current = { ...defaultMonthlySelection(data.seasons, data.currentMonthKey), noMatch: !data.seasons.some((s) => s.eligibleCount > 0 && monthIdForKey(s.months, data.currentMonthKey)) };
  }
  const seasonId = pickedSeason ?? suggested.current?.seasonId ?? "";
  const monthId = pickedMonth ?? suggested.current?.monthId ?? "";
  const noMatch = suggested.current?.noMatch ?? false;
  const seasons = data?.seasons ?? [];
  const chosen = seasons.find((s) => s.id === seasonId);
  const noMarkets = chosen != null && chosen.eligibleCount === 0;
  const create = useMutation({ mutationFn: () => api.post<{ id: string }>("/api/party-monthly-sheets", { seasonId, seasonMonthId: monthId }), onSuccess: (sheet) => onCreated(sheet.id), onError: (e) => setError((e as Error).message) });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>{T.season} *</Label>
            <NativeSelect value={seasonId} placeholder={data && seasons.length === 0 ? T.noOpen : T.select}
              options={seasons.map((s) => ({ value: s.id, label: `${s.name} ${s.year}` }))} onChange={(e) => { const next = seasons.find((s) => s.id === e.target.value); setSeasonId(e.target.value); setMonthId(next && data ? monthIdForKey(next.months, data.currentMonthKey) : ""); setError(null); }} />
            {chosen?.period && <p className="text-xs text-muted-foreground">{chosen.period}</p>}
          </div>
          <div className="space-y-1.5"><Label>{T.month} *</Label>
            <NativeSelect value={monthId} disabled={!chosen} placeholder={T.selectMonth}
              options={(chosen?.months ?? []).map((m) => ({ value: m.id, label: m.label + (chosen!.takenMonthIds.includes(m.id) ? ` ${T.exists}` : "") }))} onChange={(e) => { setMonthId(e.target.value); setError(null); }} />
          </div>
          {noMatch && !seasonId && <p className="text-sm text-muted-foreground">{T.noCurrent}</p>}
          {noMarkets && <p className="text-sm text-destructive">{fill(T.noMarkets, { season: `${chosen!.name} ${chosen!.year}` })}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{T.cancel}</Button>
          <Button disabled={!seasonId || !monthId || noMarkets || create.isPending} onClick={() => create.mutate()}>{T.create}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
