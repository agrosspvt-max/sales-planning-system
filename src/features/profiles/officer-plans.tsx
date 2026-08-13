"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { FileInput, Plus, Lock, Unlock, EyeOff, Eye, Trash2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
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
import { PlanStateBadge } from "@/features/planning/status-badge";
import type { PlanStatus } from "@/features/planning/types";
import { RecoveryImportWizard } from "@/features/recovery/recovery-import-wizard";

type PlanKind = "SEASONAL" | "MONTHLY" | "RECOVERY";
interface PlanRow {
  kind: PlanKind;
  id: string;
  planType: string;
  seasonName: string;
  monthName: string | null;
  version: number | null;
  status: PlanStatus;
  lifecycleState: string;
  source: "IMPORT" | "MANUAL";
  openHref: string;
  createdAt: string;
  updatedAt: string;
  lastSavedAt: string;
}
interface PlansResult {
  officerId: string;
  officerName: string;
  hasActiveSeasonal: boolean;
  currentSeasonId: string | null;
  rows: PlanRow[];
}

const DELETABLE: PlanStatus[] = ["DRAFT", "RETURNED", "REJECTED"];
const LIFECYCLE_BASE: Record<PlanKind, (id: string) => string> = {
  SEASONAL: (id) => `/api/planning/season-plans/${id}/lifecycle`,
  MONTHLY: (id) => `/api/planning/monthly-plans/${id}/lifecycle`,
  RECOVERY: (id) => `/api/recovery/plans/${id}/lifecycle`,
};

type Confirm =
  | { kind: "deactivate" | "delete" | "replace"; row: PlanRow }
  | null;

interface RestoreContext {
  kind: "MONTHLY" | "RECOVERY";
  childId: string;
  needsParent: boolean;
  parentPlanId: string | null;
  parentVersion: number | null;
  newerActiveVersion: { id: string; version: number } | null;
}
type RestoreMode = "WITH_PARENT" | "HISTORICAL" | "RESTORE_PARENT_ARCHIVE_NEWER";

/** Officer profile → Plans: manage every plan's lifecycle (Super Admin). Reuses the lifecycle APIs. */
export function OfficerPlansManagement({ officerId, role }: { officerId: string; role: Role }) {
  const qc = useQueryClient();
  const isAdmin = role === Role.SUPER_ADMIN;
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [restore, setRestore] = useState<{ row: PlanRow; ctx: RestoreContext } | null>(null);
  const [recoveryImport, setRecoveryImport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<PlansResult>({
    queryKey: ["officer-plans", officerId],
    queryFn: () => api.get<PlansResult>(`/api/officers/${officerId}/plans`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["officer-plans", officerId] });
    qc.invalidateQueries({ queryKey: ["plans"] });
    qc.invalidateQueries({ queryKey: ["officer-profile", officerId] });
  };

  const lifecycleMut = useMutation({
    mutationFn: (v: { row: PlanRow; action: "close" | "reopen" | "deactivate" | "reactivate" }) =>
      api.post(LIFECYCLE_BASE[v.row.kind](v.row.id), { action: v.action }),
    onSuccess: () => { setConfirm(null); setError(null); invalidate(); },
    onError: (e) => setError((e as Error).message),
  });
  const deleteMut = useMutation({
    mutationFn: (row: PlanRow) => api.del(LIFECYCLE_BASE[row.kind](row.id)),
    onSuccess: () => { setConfirm(null); setError(null); invalidate(); },
    onError: (e) => setError((e as Error).message),
  });
  const replaceMut = useMutation({
    mutationFn: (row: PlanRow) => api.post(`/api/planning/season-plans/${row.id}/replace`, {}),
    onSuccess: () => { setConfirm(null); setError(null); invalidate(); },
    onError: (e) => setError((e as Error).message),
  });
  const restoreMut = useMutation({
    mutationFn: (v: { row: PlanRow; mode: RestoreMode }) => api.post("/api/planning/lifecycle/restore", { kind: v.row.kind, id: v.row.id, mode: v.mode }),
    onSuccess: () => { setRestore(null); setError(null); invalidate(); },
    onError: (e) => setError((e as Error).message),
  });

  // Restore: Seasonal reactivates directly (cascades to children). For a Monthly/Recovery child we
  // first check whether its parent Seasonal plan is archived — if so, present the dependency dialog.
  async function openRestore(row: PlanRow) {
    setError(null);
    if (row.kind === "SEASONAL") { lifecycleMut.mutate({ row, action: "reactivate" }); return; }
    try {
      const ctx = await api.get<RestoreContext>(`/api/planning/lifecycle/restore-context?kind=${row.kind}&id=${row.id}`);
      if (ctx.needsParent) setRestore({ row, ctx });
      else lifecycleMut.mutate({ row, action: "reactivate" });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const grouped = useMemo(() => {
    const order: PlanKind[] = ["SEASONAL", "MONTHLY", "RECOVERY"];
    return order.map((k) => ({ kind: k, items: rows.filter((r) => r.kind === k) })).filter((g) => g.items.length > 0);
  }, [rows]);

  const visibility = (r: PlanRow) =>
    r.lifecycleState === "DEACTIVATED" ? "Hidden from SO" : r.lifecycleState === "CLOSED" ? "Read-only" : "Visible";

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: "Users", href: "/masters/users" }, { label: data?.officerName ?? "Officer", href: `/masters/users/${officerId}` }, { label: "Plans" }]}
        title={`${data?.officerName ?? "Officer"} — Plans`}
        subtitle="Manage the full lifecycle of every Seasonal, Monthly and Recovery plan."
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* No active Seasonal plan → reuse the Company Onboarding importer or start a fresh plan. */}
      {!isLoading && data && !data.hasActiveSeasonal && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">No active Seasonal plan for this officer.</p>
              <p className="text-sm text-muted-foreground">Import a workbook (same Company Onboarding importer) or create a fresh plan.</p>
            </div>
            {isAdmin && (
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <Link href="/planning/sales/import"><FileInput className="h-4 w-4" /> Import Workbook</Link>
                </Button>
                <Button asChild>
                  <Link href="/planning/sales"><Plus className="h-4 w-4" /> Create Seasonal Plan</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">This officer has no plans yet.</CardContent></Card>
      ) : (
        grouped.map((g) => (
          <div key={g.kind} className="space-y-2">
            <h3 className="text-sm font-semibold">{g.kind === "SEASONAL" ? "Seasonal" : g.kind === "MONTHLY" ? "Monthly" : "Recovery"}</h3>
            <div className="overflow-x-auto rounded-lg border bg-background">
              <Table stickyFirstColumn>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[140px]">Plan</TableHead>
                    <TableHead>Season</TableHead>
                    <TableHead>Month</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Visibility</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead>Last saved</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.items.map((r) => {
                    const active = r.lifecycleState === "ACTIVE";
                    const closed = r.lifecycleState === "CLOSED";
                    const deactivated = r.lifecycleState === "DEACTIVATED";
                    const canDelete = DELETABLE.includes(r.status);
                    return (
                      <TableRow key={`${r.kind}-${r.id}`}>
                        <TableCell className="font-medium">{r.planType}</TableCell>
                        <TableCell>{r.seasonName}</TableCell>
                        <TableCell>{r.monthName ?? "—"}</TableCell>
                        <TableCell>{r.version ? `v${r.version}` : "—"}</TableCell>
                        <TableCell><PlanStateBadge status={r.status} lifecycleState={r.lifecycleState} /></TableCell>
                        <TableCell className="text-muted-foreground">{visibility(r)}</TableCell>
                        <TableCell>{r.source === "IMPORT" ? <Badge variant="muted">Imported</Badge> : <span className="text-muted-foreground">Manual</span>}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(r.createdAt)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(r.updatedAt)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(r.lastSavedAt)}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button asChild variant="outline" size="sm"><Link href={r.openHref}>Open</Link></Button>
                            {isAdmin && (
                              <>
                                {active && (
                                  <Button variant="ghost" size="sm" onClick={() => lifecycleMut.mutate({ row: r, action: "close" })} disabled={lifecycleMut.isPending}>
                                    <Lock className="h-3.5 w-3.5" /> Close
                                  </Button>
                                )}
                                {closed && (
                                  <Button variant="ghost" size="sm" onClick={() => lifecycleMut.mutate({ row: r, action: "reopen" })} disabled={lifecycleMut.isPending}>
                                    <Unlock className="h-3.5 w-3.5" /> Reopen
                                  </Button>
                                )}
                                {!deactivated ? (
                                  <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: "deactivate", row: r })}>
                                    <EyeOff className="h-3.5 w-3.5" /> Deactivate
                                  </Button>
                                ) : (
                                  <Button variant="ghost" size="sm" onClick={() => openRestore(r)} disabled={lifecycleMut.isPending || restoreMut.isPending}>
                                    <Eye className="h-3.5 w-3.5" /> Restore
                                  </Button>
                                )}
                                {r.kind === "SEASONAL" && active && (
                                  <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: "replace", row: r })}>
                                    <RefreshCw className="h-3.5 w-3.5" /> Replace
                                  </Button>
                                )}
                                {r.kind === "RECOVERY" && active && (
                                  <Button variant="ghost" size="sm" onClick={() => setRecoveryImport(true)}>
                                    <RefreshCw className="h-3.5 w-3.5" /> Replace
                                  </Button>
                                )}
                                {canDelete && (
                                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirm({ kind: "delete", row: r })}>
                                    <Trash2 className="h-3.5 w-3.5" /> Delete
                                  </Button>
                                )}
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        ))
      )}

      {/* Recovery import (Create / Update / Replace) scoped to THIS officer — officer already known. */}
      <Dialog open={recoveryImport} onOpenChange={setRecoveryImport}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader><DialogTitle>Recovery Import (this officer)</DialogTitle></DialogHeader>
          <RecoveryImportWizard fixedScope={{ kind: "SINGLE", officerId }} onDone={() => { setRecoveryImport(false); invalidate(); }} />
        </DialogContent>
      </Dialog>

      {/* Confirmations for the destructive / archival actions. */}
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "delete" ? "Delete plan permanently?" : confirm?.kind === "replace" ? "Replace this seasonal plan?" : "Deactivate plan?"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            {confirm?.kind === "delete" && (
              <p><span className="font-medium text-destructive">This permanently removes planning data</span> for {confirm.row.planType} — {confirm.row.seasonName}{confirm.row.monthName ? ` · ${confirm.row.monthName}` : ""}. Dependent monthly plans are removed; recovery data is kept but unlinked. This cannot be undone.</p>
            )}
            {confirm?.kind === "deactivate" && (
              <p>The Sales Officer will no longer see this {confirm.row.planType.toLowerCase()} plan (and its dependent monthly/recovery plans follow). Nothing is deleted — you can restore it anytime.</p>
            )}
            {confirm?.kind === "replace" && (
              <p>The current active seasonal plan (and its monthly/recovery plans) will be archived (deactivated). You will then import a replacement workbook using the Company Onboarding importer.</p>
            )}
            {error && <p className="text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            {confirm?.kind === "delete" && (
              <Button variant="destructive" disabled={deleteMut.isPending} onClick={() => deleteMut.mutate(confirm.row)}>Delete permanently</Button>
            )}
            {confirm?.kind === "deactivate" && (
              <Button disabled={lifecycleMut.isPending} onClick={() => lifecycleMut.mutate({ row: confirm.row, action: "deactivate" })}>Deactivate</Button>
            )}
            {confirm?.kind === "replace" && (
              <Button disabled={replaceMut.isPending} onClick={() => replaceMut.mutate(confirm.row)}>Archive &amp; import replacement</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore dependency: this child belongs to an archived Seasonal plan. */}
      <Dialog open={!!restore} onOpenChange={(o) => !o && setRestore(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore under an archived Seasonal plan</DialogTitle>
          </DialogHeader>
          {restore && (
            <div className="space-y-3 text-sm">
              {restore.ctx.newerActiveVersion ? (
                <>
                  <p className="text-muted-foreground">
                    This {restore.row.kind === "MONTHLY" ? "monthly" : "recovery"} plan belongs to Seasonal Plan v{restore.ctx.parentVersion}, but Seasonal Plan v{restore.ctx.newerActiveVersion.version} is currently active.
                  </p>
                  <div className="flex flex-col gap-2">
                    <Button disabled={restoreMut.isPending} onClick={() => restoreMut.mutate({ row: restore.row, mode: "HISTORICAL" })}>
                      Restore as Historical View (Read Only) — recommended
                    </Button>
                    <Button variant="outline" disabled={restoreMut.isPending} onClick={() => restoreMut.mutate({ row: restore.row, mode: "RESTORE_PARENT_ARCHIVE_NEWER" })}>
                      Restore Parent v{restore.ctx.parentVersion} (archives v{restore.ctx.newerActiveVersion.version})
                    </Button>
                    <Button variant="ghost" onClick={() => setRestore(null)}>Cancel</Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-muted-foreground">
                    This {restore.row.kind === "MONTHLY" ? "monthly" : "recovery"} plan belongs to an archived Seasonal Plan (v{restore.ctx.parentVersion}). To use it, its parent Seasonal Plan must also be active.
                  </p>
                  <div className="flex flex-col gap-2">
                    <Button disabled={restoreMut.isPending} onClick={() => restoreMut.mutate({ row: restore.row, mode: "WITH_PARENT" })}>
                      Restore Parent + This Plan — recommended
                    </Button>
                    {restore.ctx.parentPlanId && (
                      <Button asChild variant="outline">
                        <Link href={`/planning/${restore.ctx.parentPlanId}`}>Open Parent Plan</Link>
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setRestore(null)}>Cancel</Button>
                  </div>
                </>
              )}
              {error && <p className="text-destructive">{error}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
