"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus, FileInput } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { MONTH_OPTIONS } from "@/lib/season-months";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/layout/page-header";
import { PlanStateBadge } from "./status-badge";
import { MonthlyPlansPanel } from "./monthly-plans-panel";
import { PLANNING_TYPE_LABELS, type PlanListItem, type PlanningType } from "./types";
import {
  CREATE_STATUSES, SUBMITTED_STATUSES, bySeasonNewestFirst, roleSections, AddFilterBar, PillNav, optionsFrom, type FilterDef,
} from "./plan-list-ui";

export type SalesMode = "create" | "view";
export type LifecycleFilter = "ACTIVE" | "CLOSED" | "DEACTIVATED" | "ALL"; // kept for MonthlyPlansPanel back-compat
type Tab = PlanningType;
type ViewSub = "SUBMITTED" | "APPROVED" | "HISTORY";

interface OfficerOption { id: string; name: string }
interface Options { officers: OfficerOption[] }
type OfficerScope = "single" | "multiple" | "all";

const TABS: Tab[] = ["SEASONAL", "MONTHLY", "YEARLY"];
const SEASON_NAMES = ["Kharif", "Rabi", "Zaid"];
const VIEW_SUBS: { value: ViewSub; label: string }[] = [
  { value: "SUBMITTED", label: "Submitted" },
  { value: "APPROVED", label: "Approved" },
  { value: "HISTORY", label: "Older Plans" },
];

/**
 * Sales Planning — one workspace with a [Create New Plan | View Plans] toggle.
 *  • Create New Plan: only editable (Draft / Returned / Rejected) plans, split into role sections.
 *  • View Plans: Submitted / Approved / History sub-tabs. History uses a dynamic "+ Add Filter".
 * Seasonal / Monthly / Yearly tabs are kept throughout; rows are always newest-first.
 */
export function SalesPlanning({ role, userId, mode }: { role: Role; userId: string; mode: SalesMode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const isAdmin = role === Role.SUPER_ADMIN;
  const isOfficer = role === Role.SALES_OFFICER;
  const isManager = role === Role.REGIONAL_MANAGER;
  const isCreate = mode === "create";
  const roleKey = role as "SALES_OFFICER" | "REGIONAL_MANAGER" | "SUPER_ADMIN";

  const [tab, setTab] = useState<Tab>("SEASONAL");
  const [viewSub, setViewSub] = useState<ViewSub>("SUBMITTED");
  const [officerFilter, setOfficerFilter] = useState(""); // admin, non-history
  const [historyFilters, setHistoryFilters] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState(false);

  // New Seasonal draft form.
  const now = new Date();
  const [seasonName, setSeasonName] = useState(SEASON_NAMES[0]);
  const [year, setYear] = useState(now.getFullYear());
  const [startMonth, setStartMonth] = useState(6);
  const [endMonth, setEndMonth] = useState(11);
  const [scope, setScope] = useState<OfficerScope>("single");
  const [officerIds, setOfficerIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Group/scope plans + (for an RM) their own plans, unioned so "My Plans" is never missed.
  const { data: scopePlans, isLoading } = useQuery<PlanListItem[]>({
    queryKey: ["plans", "scope"],
    queryFn: () => api.get<PlanListItem[]>("/api/planning/season-plans"),
  });
  const { data: minePlans } = useQuery<PlanListItem[]>({
    queryKey: ["plans", "mine"],
    queryFn: () => api.get<PlanListItem[]>("/api/planning/season-plans?mine=true"),
    enabled: isManager,
  });
  const allPlans = useMemo(() => {
    const byId = new Map<string, PlanListItem>();
    for (const p of scopePlans ?? []) byId.set(p.id, p);
    for (const p of minePlans ?? []) byId.set(p.id, p);
    return [...byId.values()];
  }, [scopePlans, minePlans]);

  const { data: options } = useQuery<Options>({
    queryKey: ["import-options"],
    queryFn: () => api.get<Options>("/api/import/dealers/options"),
    enabled: isAdmin,
  });

  const isHistory = !isCreate && viewSub === "HISTORY";

  // Filter by tab + bucket (Create / Submitted / Approved / History) + admin/history filters, newest-first.
  const rows = useMemo(() => {
    const out = allPlans.filter((p) => {
      if (p.planningType !== tab) return false;
      const lifecycle = p.lifecycleState ?? "ACTIVE";
      if (isCreate) {
        if (!CREATE_STATUSES.includes(p.status)) return false;
      } else if (viewSub === "SUBMITTED") {
        if (!SUBMITTED_STATUSES.includes(p.status)) return false;
      } else if (viewSub === "APPROVED") {
        if (!(p.status === "APPROVED" && lifecycle === "ACTIVE")) return false;
      } else {
        // HISTORY = archived / closed plans.
        if (lifecycle !== "CLOSED" && lifecycle !== "DEACTIVATED") return false;
      }
      if (isHistory) {
        // Multi-select: OR within a filter (match any selected value); empty = no constraint.
        if (historyFilters.officer?.length && !historyFilters.officer.includes(p.officerId)) return false;
        if (historyFilters.season?.length && !historyFilters.season.includes(p.seasonName)) return false;
      } else if (isAdmin && officerFilter && p.officerId !== officerFilter) {
        return false;
      }
      return true;
    });
    return out.sort(bySeasonNewestFirst);
  }, [allPlans, tab, isCreate, viewSub, isHistory, historyFilters, isAdmin, officerFilter]);

  // Role sections (SO → own; RM → My + Team; Admin → all) with bucket-specific titles.
  const sectionLabels = isCreate
    ? { mine: "My Plans", team: "Team Plans", admin: "Draft Plans" }
    : viewSub === "SUBMITTED"
      ? { mine: "My Submitted Plans", team: "Team Submitted Plans", admin: "All Submitted Plans" }
      : viewSub === "APPROVED"
        ? { mine: "My Approved Plans", team: "Team Approved Plans", admin: "All Approved Plans" }
        : { mine: "My Plans", team: "Team Plans", admin: "All Plans" };
  const sections = roleSections(rows, roleKey, userId, sectionLabels);

  // History filter definitions (only the derivable ones — Season, Sales Officer, Year).
  const historyDefs: FilterDef[] = useMemo(() => {
    const base = allPlans.filter((p) => p.planningType === tab);
    return [
      { key: "season", label: "Season", options: optionsFrom(base, (p) => ({ id: p.seasonName, label: p.seasonName })) },
      ...(isOfficer ? [] : [{ key: "officer", label: "Sales Officer", options: optionsFrom(base, (p) => ({ id: p.officerId, label: p.officerName })) }]),
    ];
  }, [allPlans, tab, isOfficer]);

  const createMut = useMutation({
    mutationFn: () =>
      api.post<{ ids: string[]; id: string | null }>("/api/planning/season-plans", {
        season: { name: seasonName, year, startMonth, endMonth },
        ...(isAdmin ? { officerScope: scope, officerIds: scope === "all" ? undefined : officerIds } : {}),
      }),
    onSuccess: (res) => {
      setOpen(false);
      if (res.ids?.length === 1 && res.id) router.push(`/planning/${res.id}`);
      else qc.invalidateQueries({ queryKey: ["plans"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  function openCreate() {
    setSeasonName(SEASON_NAMES[0]); setYear(now.getFullYear()); setStartMonth(6); setEndMonth(11);
    setScope("single"); setOfficerIds([]); setError(null); setOpen(true);
  }
  function submit() {
    setError(null);
    if (isAdmin && scope !== "all" && officerIds.length === 0) return setError("Select at least one Sales Officer.");
    createMut.mutate();
  }

  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() + i);
  const canCreateSeasonal = isCreate && tab === "SEASONAL" && (isAdmin || isOfficer || isManager);

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Sales Planning" }]}
        title="Sales Planning"
        subtitle={isCreate ? "Create or continue editable plans (Draft, Returned, Rejected)." : "Submitted, approved and historical plans."}
        actions={
          isAdmin && isCreate ? (
            <Button variant="outline" asChild>
              <Link href="/planning/sales/import"><FileInput className="h-4 w-4" /> Import Seasonal Plan</Link>
            </Button>
          ) : undefined
        }
      />

      {/* Level 1 — Create New Plan | View Plans */}
      <PillNavLinks isCreate={isCreate} createHref="/planning/sales" viewHref="/planning/sales/plans" />

      {/* Level 2 — Plan Type (View only): Submitted | Approved | Older Plans */}
      {!isCreate && (
        <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Plan Type</div>
          <div className="flex flex-wrap items-center gap-3">
            <PillNav value={viewSub} onChange={setViewSub} items={VIEW_SUBS} />
            {isHistory && <AddFilterBar defs={historyDefs} value={historyFilters} onChange={setHistoryFilters} />}
          </div>
        </div>
      )}

      {/* Level 3 — Seasonal / Monthly / Yearly */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {PLANNING_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Admin officer filter (not on Older Plans, which uses + Add Filter above). */}
          {isAdmin && !isHistory && (
            <NativeSelect
              className="w-56"
              options={[{ value: "", label: "All Sales Officers" }, ...(options?.officers ?? []).map((o) => ({ value: o.id, label: o.name }))]}
              value={officerFilter}
              onChange={(e) => setOfficerFilter(e.target.value)}
            />
          )}
          {canCreateSeasonal && <Button onClick={openCreate}><Plus className="h-4 w-4" /> Create Seasonal Plan</Button>}
        </div>
      </div>

      {tab === "MONTHLY" ? (
        <MonthlyPlansPanel role={role} userId={userId} mode={mode} subView={isCreate ? "CREATE" : viewSub} officerFilter={officerFilter} historyFilters={historyFilters} />
      ) : (
        <div className="space-y-6">
          {sections.map((sec) => (
            <PlanSection key={sec.key} title={sec.title} showTitle rows={sec.rows} isOfficer={isOfficer} loading={isLoading} />
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Create Seasonal Plan</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Season</Label>
                <NativeSelect options={SEASON_NAMES.map((n) => ({ value: n, label: n }))} value={seasonName} onChange={(e) => setSeasonName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Year</Label>
                <NativeSelect options={years.map((y) => ({ value: String(y), label: String(y) }))} value={String(year)} onChange={(e) => setYear(Number(e.target.value))} />
              </div>
              <div className="space-y-1.5">
                <Label>Start Month</Label>
                <NativeSelect options={MONTH_OPTIONS} value={String(startMonth)} onChange={(e) => setStartMonth(Number(e.target.value))} />
              </div>
              <div className="space-y-1.5">
                <Label>End Month</Label>
                <NativeSelect options={MONTH_OPTIONS} value={String(endMonth)} onChange={(e) => setEndMonth(Number(e.target.value))} />
              </div>
            </div>

            {isAdmin && (
              <div className="space-y-2 border-t pt-3">
                <Label>Sales Officer</Label>
                <NativeSelect
                  options={[{ value: "single", label: "Single Officer" }, { value: "multiple", label: "Multiple Officers" }, { value: "all", label: "All Officers" }]}
                  value={scope}
                  onChange={(e) => { setScope(e.target.value as OfficerScope); setOfficerIds([]); }}
                />
                {scope === "single" && (
                  <NativeSelect
                    placeholder="Select a Sales Officer…"
                    options={(options?.officers ?? []).map((o) => ({ value: o.id, label: o.name }))}
                    value={officerIds[0] ?? ""}
                    onChange={(e) => setOfficerIds(e.target.value ? [e.target.value] : [])}
                  />
                )}
                {scope === "multiple" && (
                  <div className="max-h-40 space-y-1 overflow-auto rounded-md border p-2">
                    {(options?.officers ?? []).map((o) => (
                      <label key={o.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4" checked={officerIds.includes(o.id)} onChange={(e) => setOfficerIds((prev) => (e.target.checked ? [...prev, o.id] : prev.filter((id) => id !== o.id)))} />
                        {o.name}
                      </label>
                    ))}
                  </div>
                )}
                {scope === "all" && <p className="text-xs text-muted-foreground">A draft will be created (or reopened) for every active Sales Officer.</p>}
              </div>
            )}

            <p className="text-xs text-muted-foreground">One Seasonal Plan per officer, per season + year. If a draft already exists it will be reopened — never duplicated.</p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={createMut.isPending}>{createMut.isPending ? "Creating…" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** [Create New Plan | View Plans] toggle rendered as links (each side is its own route). */
function PillNavLinks({ isCreate, createHref, viewHref }: { isCreate: boolean; createHref: string; viewHref: string }) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
      <Link href={createHref} className={`rounded px-3 py-1.5 font-medium ${isCreate ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>Create New Plan</Link>
      <Link href={viewHref} className={`rounded px-3 py-1.5 font-medium ${!isCreate ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>View Plans</Link>
    </div>
  );
}

/** One role section (heading + table) for Seasonal / Yearly plan rows. */
function PlanSection({ title, showTitle, rows, isOfficer, loading }: { title: string; showTitle: boolean; rows: PlanListItem[]; isOfficer: boolean; loading: boolean }) {
  return (
    <div className="space-y-2">
      {showTitle && <h3 className="text-sm font-semibold">{title}</h3>}
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              {!isOfficer && <TableHead>Sales Officer</TableHead>}
              <TableHead>State</TableHead>
              <TableHead>Territory</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last saved</TableHead>
              <TableHead className="text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No plans here.</TableCell></TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.seasonName}</TableCell>
                  {!isOfficer && <TableCell>{p.officerName}</TableCell>}
                  <TableCell>{p.groupName ? <Badge variant="secondary">{p.groupName}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{p.territory ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    v{p.version}{p.versionName ? ` · ${p.versionName}` : ""}
                    {p.source === "IMPORT" && <Badge variant="muted" className="ml-1">Imported</Badge>}
                  </TableCell>
                  <TableCell><PlanStateBadge status={p.status} lifecycleState={p.lifecycleState} /></TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(p.lastSavedAt)}</TableCell>
                  <TableCell className="text-right"><Button asChild variant="outline" size="sm"><Link href={`/planning/${p.id}`}>Open</Link></Button></TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
