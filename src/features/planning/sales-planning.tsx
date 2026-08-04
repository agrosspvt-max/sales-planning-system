"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus, FileInput } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";
import { MONTH_OPTIONS } from "@/lib/season-months";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/layout/page-header";
import { PlanStateBadge } from "./status-badge";
import { MonthlyPlansPanel } from "./monthly-plans-panel";
import { PLANNING_TYPE_LABELS, type PlanListItem, type PlanningType, type PlanStatus } from "./types";

export type SalesMode = "create" | "view";
export type LifecycleFilter = "ACTIVE" | "CLOSED" | "DEACTIVATED" | "ALL";
type Tab = PlanningType;
const LIFECYCLE_FILTERS: { value: LifecycleFilter; label: string }[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "CLOSED", label: "Closed" },
  { value: "DEACTIVATED", label: "Deactivated" },
  { value: "ALL", label: "All" },
];

interface OfficerOption {
  id: string;
  name: string;
}
interface Options {
  officers: OfficerOption[];
}
type OfficerScope = "single" | "multiple" | "all";

const TABS: Tab[] = ["SEASONAL", "MONTHLY", "YEARLY"];
const SEASON_NAMES = ["Kharif", "Rabi", "Zaid"];
// Editable = work-in-progress a Sales Officer can still change (draft or sent back).
const EDITABLE_STATUSES: PlanStatus[] = ["DRAFT", "RETURNED", "REJECTED"];

/**
 * Sales Planning — one component, two modes. Create Plan shows only editable plans and can
 * start a new Seasonal draft; View Plans shows only Approved plans (read-only). The dataset,
 * permissions and read-only state differ; the screens are shared (no duplicate pages).
 */
export function SalesPlanning({ role, mode }: { role: Role; mode: SalesMode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const isAdmin = role === Role.SUPER_ADMIN;
  const isOfficer = role === Role.SALES_OFFICER;
  const isCreate = mode === "create";

  const [tab, setTab] = useState<Tab>("SEASONAL");
  const [officerFilter, setOfficerFilter] = useState(""); // admin: "" = all officers
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>("ACTIVE");
  const [open, setOpen] = useState(false);

  // New Seasonal draft form
  const now = new Date();
  const [seasonName, setSeasonName] = useState(SEASON_NAMES[0]);
  const [year, setYear] = useState(now.getFullYear());
  const [startMonth, setStartMonth] = useState(6);
  const [endMonth, setEndMonth] = useState(11);
  const [scope, setScope] = useState<OfficerScope>("single");
  const [officerIds, setOfficerIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: plans, isLoading } = useQuery<PlanListItem[]>({
    queryKey: ["plans"],
    queryFn: () => api.get<PlanListItem[]>("/api/planning/season-plans"),
  });
  const { data: options } = useQuery<Options>({
    queryKey: ["import-options"],
    queryFn: () => api.get<Options>("/api/import/dealers/options"),
    enabled: isAdmin,
  });

  const rows = useMemo(() => {
    return (plans ?? []).filter((p) => {
      if (p.planningType !== tab) return false;
      // Create = editable only; View = Approved only. (Submitted/pending never in Create.)
      if (isCreate ? !EDITABLE_STATUSES.includes(p.status) : p.status !== "APPROVED") return false;
      // Lifecycle filter (Active / Closed / Deactivated / All). Default Active preserves prior behavior.
      if (lifecycleFilter !== "ALL" && (p.lifecycleState ?? "ACTIVE") !== lifecycleFilter) return false;
      if (isAdmin && officerFilter && p.officerId !== officerFilter) return false;
      return true;
    });
  }, [plans, tab, isCreate, isAdmin, officerFilter, lifecycleFilter]);

  const createMut = useMutation({
    mutationFn: () =>
      api.post<{ ids: string[]; id: string | null }>("/api/planning/season-plans", {
        season: { name: seasonName, year, startMonth, endMonth },
        ...(isAdmin ? { officerScope: scope, officerIds: scope === "all" ? undefined : officerIds } : {}),
      }),
    onSuccess: (res) => {
      setOpen(false);
      // Open the new draft directly when a single plan was created; otherwise refresh the list.
      if (res.ids?.length === 1 && res.id) router.push(`/planning/${res.id}`);
      else qc.invalidateQueries({ queryKey: ["plans"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  function openCreate() {
    setSeasonName(SEASON_NAMES[0]);
    setYear(now.getFullYear());
    setStartMonth(6);
    setEndMonth(11);
    setScope("single");
    setOfficerIds([]);
    setError(null);
    setOpen(true);
  }

  function submit() {
    setError(null);
    if (isAdmin) {
      if (scope !== "all" && officerIds.length === 0) return setError("Select at least one Sales Officer.");
    }
    createMut.mutate();
  }

  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() + i);
  const canCreateSeasonal = isCreate && tab === "SEASONAL" && (isAdmin || isOfficer);

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: isCreate ? "Create New Plan" : "View Approved Plans" }, { label: "Sales Planning" }]}
        title="Sales Planning"
        subtitle={
          isCreate
            ? "Start or continue Draft plans. Approved plans move to View Approved Plans."
            : "Approved plans (read-only)."
        }
        actions={
          isAdmin && isCreate ? (
            <Button variant="outline" asChild>
              <Link href="/planning/sales/import">
                <FileInput className="h-4 w-4" /> Import Seasonal Plan
              </Link>
            </Button>
          ) : undefined
        }
      />

      {/* Primary navigation inside Sales Planning: Create New Plan | View Approved Plans */}
      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
        <Link
          href="/planning/sales"
          className={cn("rounded px-3 py-1.5 font-medium", isCreate ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          Create New Plan
        </Link>
        <Link
          href="/planning/sales/plans"
          className={cn("rounded px-3 py-1.5 font-medium", !isCreate ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          View Approved Plans
        </Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {PLANNING_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Lifecycle filter — Active (default) / Closed / Deactivated / All. */}
          <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
            {LIFECYCLE_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setLifecycleFilter(f.value)}
                className={cn("rounded px-2.5 py-1 font-medium", lifecycleFilter === f.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {f.label}
              </button>
            ))}
          </div>
          {isAdmin && (
            <NativeSelect
              className="w-56"
              placeholder="All Sales Officers"
              options={[{ value: "", label: "All Sales Officers" }, ...(options?.officers ?? []).map((o) => ({ value: o.id, label: o.name }))]}
              value={officerFilter}
              onChange={(e) => setOfficerFilter(e.target.value)}
            />
          )}
          {canCreateSeasonal && (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> Create Seasonal Plan
            </Button>
          )}
        </div>
      </div>

      {tab === "MONTHLY" ? (
        <MonthlyPlansPanel role={role} mode={mode} officerFilter={officerFilter} lifecycleFilter={lifecycleFilter} />
      ) : (
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              {!isOfficer && <TableHead>Sales Officer</TableHead>}
              <TableHead>Version</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last saved</TableHead>
              <TableHead className="text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  {isCreate
                    ? `No editable ${PLANNING_TYPE_LABELS[tab].toLowerCase()} plans.`
                    : `No approved ${PLANNING_TYPE_LABELS[tab].toLowerCase()} plans.`}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.seasonName}</TableCell>
                  {!isOfficer && <TableCell>{p.officerName}</TableCell>}
                  <TableCell>
                    v{p.version}
                    {p.versionName ? ` · ${p.versionName}` : ""}
                    {p.source === "IMPORT" && <Badge variant="muted" className="ml-1">Imported</Badge>}
                  </TableCell>
                  <TableCell><PlanStateBadge status={p.status} lifecycleState={p.lifecycleState} /></TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(p.lastSavedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/planning/${p.id}`}>Open</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Seasonal Plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Season</Label>
                <NativeSelect
                  options={SEASON_NAMES.map((n) => ({ value: n, label: n }))}
                  value={seasonName}
                  onChange={(e) => setSeasonName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Year</Label>
                <NativeSelect
                  options={years.map((y) => ({ value: String(y), label: String(y) }))}
                  value={String(year)}
                  onChange={(e) => setYear(Number(e.target.value))}
                />
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
                  options={[
                    { value: "single", label: "Single Officer" },
                    { value: "multiple", label: "Multiple Officers" },
                    { value: "all", label: "All Officers" },
                  ]}
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value as OfficerScope);
                    setOfficerIds([]);
                  }}
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
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={officerIds.includes(o.id)}
                          onChange={(e) =>
                            setOfficerIds((prev) => (e.target.checked ? [...prev, o.id] : prev.filter((id) => id !== o.id)))
                          }
                        />
                        {o.name}
                      </label>
                    ))}
                  </div>
                )}
                {scope === "all" && <p className="text-xs text-muted-foreground">A draft will be created (or reopened) for every active Sales Officer.</p>}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              One Seasonal Plan per officer, per season + year. If a draft already exists it will be reopened — never duplicated.
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={createMut.isPending}>
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
