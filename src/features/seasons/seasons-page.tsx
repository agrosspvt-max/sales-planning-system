"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Search, Lock, CalendarClock } from "lucide-react";
import { SeasonMonthsDialog } from "./season-months-dialog";
import { api } from "@/lib/api-client";
import { PLANNING_MODES, PLANNING_MODE_LABELS, type PlanningMode } from "@/lib/calc";
import {
  MONTH_OPTIONS,
  MONTH_NAMES,
  generateSeasonMonths,
  formatPeriod,
} from "@/lib/season-months";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Season {
  id: string;
  name: string;
  year: number;
  startMonth: number | null;
  startYear: number | null;
  endMonth: number | null;
  endYear: number | null;
  status: "OPEN" | "CLOSED";
  seasonalMode: PlanningMode;
  monthlyMode: PlanningMode;
  months: string[];
  locked: boolean;
}

interface DefaultConfig {
  seasonalMode: PlanningMode;
  monthlyMode: PlanningMode;
}

const thisYear = new Date().getFullYear();

export function SeasonsPage({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLocked, setEditingLocked] = useState(false);
  const [search, setSearch] = useState("");

  const [name, setName] = useState("");
  const [startMonth, setStartMonth] = useState(6);
  const [startYear, setStartYear] = useState(thisYear);
  const [endMonth, setEndMonth] = useState(11);
  const [endYear, setEndYear] = useState(thisYear);
  const [seasonalMode, setSeasonalMode] = useState<PlanningMode>("PACK_SIZE");
  const [monthlyMode, setMonthlyMode] = useState<PlanningMode>("PACK_SIZE");
  const [monthsFor, setMonthsFor] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Season[]>({
    queryKey: ["seasons", search],
    queryFn: () => api.get<Season[]>(`/api/seasons?search=${encodeURIComponent(search)}`),
  });

  // The global Planning Configuration provides only the DEFAULT for new seasons.
  const { data: defaults } = useQuery<DefaultConfig>({
    queryKey: ["planning-config"],
    queryFn: () => api.get<DefaultConfig>("/api/settings/planning-config"),
    enabled: canManage,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["seasons"] });

  const createMut = useMutation({
    mutationFn: (payload: SeasonPayload) => api.post("/api/seasons", payload),
    onSuccess: () => {
      invalidate();
      setOpen(false);
    },
  });
  const updateMut = useMutation({
    mutationFn: ({ id, ...payload }: SeasonPayload & { id: string }) =>
      api.patch(`/api/seasons/${id}`, payload),
    onSuccess: () => {
      invalidate();
      setOpen(false);
    },
  });
  const statusMut = useMutation({
    mutationFn: (vars: { id: string; status: "OPEN" | "CLOSED" }) =>
      api.post(`/api/seasons/${vars.id}/status`, { status: vars.status }),
    onSuccess: invalidate,
  });

  // Live month preview + validation, shared with the server generator.
  const preview = useMemo(
    () => generateSeasonMonths({ startMonth, startYear, endMonth, endYear }),
    [startMonth, startYear, endMonth, endYear],
  );

  function openCreate() {
    setEditingId(null);
    setEditingLocked(false);
    setName("");
    setStartMonth(6);
    setStartYear(thisYear);
    setEndMonth(11);
    setEndYear(thisYear);
    setSeasonalMode(defaults?.seasonalMode ?? "PACK_SIZE");
    setMonthlyMode(defaults?.monthlyMode ?? "PACK_SIZE");
    setError(null);
    setOpen(true);
  }

  function openEdit(s: Season) {
    setEditingId(s.id);
    setEditingLocked(s.locked);
    setName(s.name);
    // Prefill from stored period, or infer from the month list for legacy seasons.
    const names = MONTH_NAMES as readonly string[];
    const inferStart = s.months[0] ? names.indexOf(s.months[0]) + 1 : 6;
    const inferEnd = s.months.length ? names.indexOf(s.months[s.months.length - 1]) + 1 : 11;
    setStartMonth(s.startMonth ?? (inferStart || 6));
    setStartYear(s.startYear ?? s.year);
    setEndMonth(s.endMonth ?? (inferEnd || 11));
    setEndYear(s.endYear ?? s.year);
    setSeasonalMode(s.seasonalMode);
    setMonthlyMode(s.monthlyMode);
    setError(null);
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Season name is required.");
      return;
    }
    if (!preview.ok) {
      setError(preview.error ?? "Invalid season period.");
      return;
    }
    const payload: SeasonPayload = {
      name: name.trim(),
      startMonth,
      startYear,
      endMonth,
      endYear,
      seasonalMode,
      monthlyMode,
    };
    try {
      if (editingId) await updateMut.mutateAsync({ id: editingId, ...payload });
      else await createMut.mutateAsync(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save season");
    }
  }

  const saving = createMut.isPending || updateMut.isPending;
  const periodLocked = editingId !== null && editingLocked;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Seasons"
        subtitle="Define a season by its period; months are generated automatically."
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> New Season
            </Button>
          ) : undefined
        }
      />

      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Search seasons…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Seasonal Mode</TableHead>
              <TableHead>Monthly Mode</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ) : (data?.length ?? 0) === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  No seasons yet.
                </TableCell>
              </TableRow>
            ) : (
              data!.map((s) => {
                const period =
                  formatPeriod(s.startMonth, s.startYear, s.endMonth, s.endYear) ||
                  s.months.join(", ");
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      {s.name}
                      {s.locked && (
                        <Lock className="ml-1 inline h-3 w-3 text-muted-foreground" aria-label="Locked" />
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{period}</TableCell>
                    <TableCell>{PLANNING_MODE_LABELS[s.seasonalMode]}</TableCell>
                    <TableCell>{PLANNING_MODE_LABELS[s.monthlyMode]}</TableCell>
                    <TableCell>
                      <Badge variant={s.status === "OPEN" ? "success" : "muted"}>{s.status}</Badge>
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" title="Manage months" onClick={() => setMonthsFor({ id: s.id, name: `${s.name} ${s.year}` })}>
                            <CalendarClock className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" title="Edit" onClick={() => openEdit(s)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              statusMut.mutate({
                                id: s.id,
                                status: s.status === "OPEN" ? "CLOSED" : "OPEN",
                              })
                            }
                          >
                            {s.status === "OPEN" ? "Close" : "Reopen"}
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Season" : "New Season"}</DialogTitle>
          </DialogHeader>

          {periodLocked && (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>
                This season already contains planning data. Season period and planning modes can no
                longer be changed. You can still rename it.
              </span>
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="s-name">Season name</Label>
              <Input
                id="s-name"
                placeholder="Kharif"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Start month</Label>
                <NativeSelect
                  options={MONTH_OPTIONS}
                  value={String(startMonth)}
                  disabled={periodLocked}
                  onChange={(e) => setStartMonth(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s-start-year">Start year</Label>
                <Input
                  id="s-start-year"
                  type="number"
                  value={startYear}
                  disabled={periodLocked}
                  onChange={(e) => setStartYear(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>End month</Label>
                <NativeSelect
                  options={MONTH_OPTIONS}
                  value={String(endMonth)}
                  disabled={periodLocked}
                  onChange={(e) => setEndMonth(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s-end-year">End year</Label>
                <Input
                  id="s-end-year"
                  type="number"
                  value={endYear}
                  disabled={periodLocked}
                  onChange={(e) => setEndYear(Number(e.target.value))}
                />
              </div>
            </div>

            {/* Live preview of the months that will be created. */}
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Season Months {preview.ok && `(${preview.months.length})`}
              </p>
              {preview.ok ? (
                <div className="flex flex-wrap gap-1">
                  {preview.months.map((m) => (
                    <Badge key={m.order} variant="secondary">
                      {m.name} {m.year}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-destructive">{preview.error}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Seasonal planning mode</Label>
                <NativeSelect
                  options={PLANNING_MODES.map((m) => ({ value: m, label: PLANNING_MODE_LABELS[m] }))}
                  value={seasonalMode}
                  disabled={periodLocked}
                  onChange={(e) => setSeasonalMode(e.target.value as PlanningMode)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Monthly planning mode</Label>
                <NativeSelect
                  options={PLANNING_MODES.map((m) => ({ value: m, label: PLANNING_MODE_LABELS[m] }))}
                  value={monthlyMode}
                  disabled={periodLocked}
                  onChange={(e) => setMonthlyMode(e.target.value as PlanningMode)}
                />
              </div>
              {!periodLocked && (
                <p className="col-span-2 text-xs text-muted-foreground">
                  Prefilled from the global default (Planning Configuration). Saved with this season
                  and fixed once it contains planning data.
                </p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !preview.ok}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <SeasonMonthsDialog
        seasonId={monthsFor?.id ?? null}
        seasonName={monthsFor?.name ?? ""}
        open={monthsFor !== null}
        onOpenChange={(o) => !o && setMonthsFor(null)}
      />
    </div>
  );
}

interface SeasonPayload {
  name: string;
  startMonth: number;
  startYear: number;
  endMonth: number;
  endYear: number;
  seasonalMode: PlanningMode;
  monthlyMode: PlanningMode;
}
