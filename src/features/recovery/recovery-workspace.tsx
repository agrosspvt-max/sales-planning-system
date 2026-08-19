"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Ban, Save } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SectionColgroup } from "@/components/ui/table-group";
import { Th, LabelSectionHeaderRow, type LabelSection } from "@/features/labels/label-ui";
import { StatusBadge } from "@/features/planning/status-badge";
import { DealerProgressBar, NoPlanDialog, type StatusCounts } from "@/features/planning/dealer-completion";
import { DealerPlanningStatus } from "@/features/planning/dealer-status";
import { useAutosaveMap } from "@/features/planning/use-autosave-map";
import { recoveryMonthTotals, recoveryWeekTotals, weekTillDate, weekAll, storedWeek, type RecoveryValue } from "./recovery-calc";
import { AdminEditBar, EditPlanButton, ChangeReviewDialog } from "@/features/planning/admin-edit-ui";
import { RecoveryActions } from "./recovery-actions";
import { RecoveryHistory } from "./recovery-history";
import type { PlanStatus } from "@/features/planning/types";

interface RecoveryDealer {
  dealerId: string;
  dealerName: string;
  outstanding: number;
  overdue: number;
  due: number;
  running: number;
  // Opening balances for the month (frozen after the first import) + Daybook-derived business values.
  outstandingTillDate: number;
  runningTillDate: number;
  srCr: number;
  liveRecovery: number;
  // DERIVED: Live Recovery + SR/CR − (Due + Overdue). Auto-refreshes from Daybook or Aging changes.
  actualRunningRecovery: number;
  monthRecoveryPlan: number;
  monthRunningRecovery: number;
  noPlan: boolean;
  noPlanReason: string | null;
  completed: boolean;
  weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }>;
  // Month's Due split across the four business weeks by invoice due date. Week View shows the
  // selected week's slice; Month View continues to show the aggregate `due`.
  dueByWeek: Record<number, number>;
  // Change tracking vs the previous snapshot (aging-derived business data only).
  prevAging: { outstanding: number; overdue: number; due: number; running: number } | null;
  changed: boolean;
  // Kept in the plan but absent from the newest Aging snapshot → shown values are the last known.
  missingInLatestAging?: boolean;
}
interface LastRefresh {
  at: string;
  businessWeek: number;
  outstandingIncreased: number;
  outstandingDecreased: number;
  newDealers: number;
  removedDealers: number;
  outstandingDelta: number;
}
interface RecoveryDetail {
  id: string;
  status: PlanStatus;
  officerId: string;
  officerName: string;
  seasonName: string;
  monthName: string;
  cutoffDate: string;
  weeklyEditEnabled: boolean;
  monthEditable: boolean;
  weekEditable: boolean;
  canAdminEdit?: boolean;
  weekCount: number;
  currentWeek: number;
  lastRefresh: LastRefresh | null;
  dealers: RecoveryDealer[];
}

type Tab = "month" | "week" | "history";
const money = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n));
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Compact dd/mm for dynamic column headers (aging cutoff / month opening). */
const ddmm = (d: Date | string) => {
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(x.getDate())}/${p(x.getMonth() + 1)}`;
};
/** First calendar day of the aging cutoff's month — the "Outstanding Till" opening date. */
const monthFirstDdMm = (cutoff: Date | string) => {
  const x = new Date(cutoff);
  return ddmm(new Date(x.getFullYear(), x.getMonth(), 1));
};
/** Second header line showing a dynamic date under a (still label-editable) column title. */
function DateSuffix({ date }: { date: string }) {
  return <span className="block text-[10px] font-normal normal-case text-muted-foreground">{date}</span>;
}

/**
 * Business-aware change delta for receivables: a DECREASE is good (green), an increase is bad (red).
 * The main value stays in the normal theme color; only the small delta is coloured. Theme-safe.
 */
function Delta({ value }: { value: number }) {
  if (Math.round(value) === 0) return null;
  const good = value < 0;
  return (
    <div className={cn("text-[10px] font-medium tabular-nums", good ? "text-success" : "text-destructive")}>
      {good ? "▼" : "▲"} {value < 0 ? "-" : "+"}{money(Math.abs(value))}
    </div>
  );
}

/**
 * Percentage badge for Actual Running Recovery: ARR expressed as a percentage of the dealer's Running
 * Recovery Plan. Positive → green (▲), negative → red (▼). The ARR VALUE itself is unchanged; this only
 * decorates it. No badge when there is no plan to compare against (base 0) or the percentage rounds to 0.
 */
function PctDelta({ value, base }: { value: number; base: number }) {
  if (!base) return null;
  const p = (value / base) * 100;
  if (Math.abs(Math.round(p * 10)) === 0) return null; // < 0.05% → nothing meaningful to show
  const good = p > 0;
  return (
    <div className={cn("text-[10px] font-medium tabular-nums", good ? "text-success" : "text-destructive")}>
      {good ? "▲" : "▼"} {p < 0 ? "-" : ""}{Math.abs(p).toFixed(1)}%
    </div>
  );
}

/** An aging value with an optional change delta underneath (vs the previous snapshot). */
function AgingCell({ value, prev }: { value: number; prev: number | null | undefined }) {
  return (
    <div className="text-right tabular-nums">
      <div>{money(value)}</div>
      {prev != null && <Delta value={value - prev} />}
    </div>
  );
}

/**
 * Planning Guidance — a small informational panel shown after a refresh. It summarises the business
 * change, the remaining monthly commitment, and which weeks are locked. GUIDANCE ONLY: it never
 * modifies any planning value.
 */
function GuidancePanel({ data }: { data: RecoveryDetail }) {
  const commitment = data.dealers.reduce((s, d) => s + d.monthRecoveryPlan, 0);
  const recovered = data.dealers.reduce((s, d) => s + d.monthRunningRecovery, 0);
  const remaining = Math.max(0, commitment - recovered);
  const lr = data.lastRefresh;
  if (!lr && data.currentWeek <= 1) return null; // nothing to guide at month start, no refresh yet
  const lockNote =
    data.currentWeek > 1
      ? `Weeks 1–${data.currentWeek - 1} locked · Weeks ${data.currentWeek}–${data.weekCount} editable`
      : `All weeks (1–${data.weekCount}) editable`;
  return (
    <div className="rounded-lg border bg-muted/20 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        {lr && (
          <span>
            Business update:{" "}
            {Math.round(lr.outstandingDelta) === 0 ? (
              <span className="text-muted-foreground">no net Outstanding change</span>
            ) : (
              <span className={lr.outstandingDelta < 0 ? "text-success" : "text-destructive"}>
                Outstanding {lr.outstandingDelta < 0 ? "decreased" : "increased"} by {money(Math.abs(lr.outstandingDelta))}
              </span>
            )}
          </span>
        )}
        <span>
          Remaining monthly commitment: <span className="font-medium tabular-nums">{money(remaining)}</span>
        </span>
        <span className="text-muted-foreground">{lockNote}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Guidance only — planning values are never changed automatically.</p>
    </div>
  );
}

export function RecoveryWorkspace({ id, role, userId }: { id: string; role: Role; userId: string }) {
  const [tab, setTab] = useState<Tab>("month");
  const { data, isLoading } = useQuery<RecoveryDetail>({
    queryKey: ["recovery-plan", id],
    queryFn: () => api.get(`/api/recovery/plans/${id}`),
  });
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const remaining = data.dealers.filter((d) => !d.noPlan && !d.completed);
  const noPlanDealers = data.dealers.filter((d) => d.noPlan);
  const counts: StatusCounts = {
    completed: data.dealers.filter((d) => !d.noPlan && d.completed).length,
    noPlan: noPlanDealers.length,
    remaining: remaining.length,
    total: data.dealers.length,
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "month", label: "Month View" },
    { key: "week", label: "Week View" },
    { key: "history", label: "History" },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        backTo="/planning/recovery"
        crumbs={[{ label: "Planning" }, { label: "Recovery Planning", href: "/planning/recovery" }, { label: `${data.seasonName} · ${data.monthName}` }]}
        title={`${data.seasonName} — ${data.monthName} Recovery`}
        subtitle={`Cutoff ${formatDate(data.cutoffDate)} · ${data.officerName}`}
        actions={<StatusBadge status={data.status} />}
      />

      <RecoveryActions
        id={id}
        status={data.status}
        officerId={data.officerId}
        role={role}
        userId={userId}
        remainingCount={remaining.length}
        totalDealers={data.dealers.length}
        noPlanDealers={noPlanDealers.map((d) => ({ dealerId: d.dealerId, dealerName: d.dealerName, noPlanReason: d.noPlanReason }))}
      />

      <GuidancePanel data={data} />

      <DealerProgressBar counts={counts} />

      <div className="flex items-center gap-1 border-b">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={cn("border-b-2 px-3 py-2 text-sm font-medium transition-colors", tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "month" && <MonthView key={data.id + data.status} detail={data} />}
      {tab === "week" && <WeekView key={data.id + data.status} detail={data} />}
      {tab === "history" && <RecoveryHistory id={id} role={role} />}
    </div>
  );
}

/* ------------------------------- Month View ------------------------------- */

function MonthView({ detail }: { detail: RecoveryDetail }) {
  const qc = useQueryClient();
  const editable = detail.monthEditable;
  // Dynamic column dates: Current Outstanding is as of the aging cutoff; Outstanding Till is the month's
  // opening (first calendar day of the cutoff's month). Both derived from the plan cutoff — no calc change.
  const cutoffDdMm = ddmm(detail.cutoffDate);
  const tillDdMm = monthFirstDdMm(detail.cutoffDate);
  // Admin Edit Mode: staged overlay, separate from the officer autosave path.
  const canAdminEdit = !!detail.canAdminEdit;
  const [adminMode, setAdminMode] = useState(false);
  const [adminEdits, setAdminEdits] = useState<Record<string, { plan: number; running: number }>>({});
  const [adminSaving, setAdminSaving] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const initial = useMemo(() => {
    const m: Record<string, { plan: number; running: number }> = {};
    for (const d of detail.dealers) m[d.dealerId] = { plan: d.monthRecoveryPlan, running: d.monthRunningRecovery };
    return m;
  }, [detail]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seed = useMemo(() => initial, [detail.id]);

  const persist = async (keys: string[], snap: Record<string, { plan: number; running: number }>) => {
    const entries = keys.map((dealerId) => ({ dealerId, monthRecoveryPlan: snap[dealerId]?.plan ?? 0, monthRunningRecovery: snap[dealerId]?.running ?? 0 }));
    await api.patch(`/api/recovery/plans/${detail.id}/month`, { entries });
    qc.invalidateQueries({ queryKey: ["recovery-plan", detail.id] });
  };
  const { values, saving, update, flush } = useAutosaveMap<{ plan: number; running: number }>(seed, persist);

  const [noPlanFor, setNoPlanFor] = useState<RecoveryDealer | null>(null);
  const noPlanMut = useMutation({
    mutationFn: (vars: { dealerId: string; noPlan: boolean; reason?: string }) => api.post(`/api/recovery/plans/${detail.id}/dealers/${vars.dealerId}/no-plan`, vars),
    onSuccess: () => { setNoPlanFor(null); qc.invalidateQueries({ queryKey: ["recovery-plan", detail.id] }); },
  });

  const valFor = (dealerId: string) => (adminMode ? adminEdits[dealerId] ?? initial[dealerId] ?? { plan: 0, running: 0 } : values[dealerId] ?? { plan: 0, running: 0 });
  const set = (dealerId: string, field: "plan" | "running", raw: string) => {
    const n = Math.max(0, Number(raw) || 0);
    if (adminMode) {
      setAdminEdits((prev) => { const cur = prev[dealerId] ?? initial[dealerId] ?? { plan: 0, running: 0 }; return { ...prev, [dealerId]: { ...cur, [field]: n } }; });
      return;
    }
    const cur = values[dealerId] ?? { plan: 0, running: 0 };
    update(dealerId, { ...cur, [field]: n });
  };
  const enterAdminMode = () => { setAdminEdits(initial); setAdminError(null); setAdminMode(true); };
  const cancelAdminMode = () => { setAdminMode(false); setAdminEdits({}); setAdminError(null); };
  const adminChanges = () => {
    const out: { dealerName: string; fieldName: string; oldValue: number; newValue: number }[] = [];
    for (const d of detail.dealers) {
      const base = initial[d.dealerId] ?? { plan: 0, running: 0 };
      const cur = adminEdits[d.dealerId] ?? base;
      if (base.plan !== cur.plan) out.push({ dealerName: d.dealerName, fieldName: "Month Recovery Plan", oldValue: base.plan, newValue: cur.plan });
      if (base.running !== cur.running) out.push({ dealerName: d.dealerName, fieldName: "Month Running Recovery", oldValue: base.running, newValue: cur.running });
    }
    return out;
  };
  const adminSave = async (reason: string) => {
    const entries: { dealerId: string; monthRecoveryPlan: number; monthRunningRecovery: number }[] = [];
    for (const d of detail.dealers) {
      const base = initial[d.dealerId] ?? { plan: 0, running: 0 };
      const cur = adminEdits[d.dealerId] ?? base;
      if (base.plan !== cur.plan || base.running !== cur.running) entries.push({ dealerId: d.dealerId, monthRecoveryPlan: cur.plan, monthRunningRecovery: cur.running });
    }
    setAdminSaving(true); setAdminError(null);
    try {
      await api.post(`/api/recovery/plans/${detail.id}/admin-edit`, { view: "month", entries, reason });
      qc.invalidateQueries({ queryKey: ["recovery-plan", detail.id] });
      setAdminMode(false); setAdminEdits({}); setReviewOpen(false);
    } catch (e) { setAdminError((e as Error).message); }
    finally { setAdminSaving(false); }
  };

  // Deliberately derived in the client from the live edit map: this makes the summary move with
  // each keystroke, while keeping totals out of the persisted Recovery Plan data.
  // Reuses the shared roll-up. Behaviour preserved: the workspace keeps summing per-dealer ratios for
  // Recovery % ("sumOfRatios") and reads the live edit map for each dealer's plan/running.
  const totals = useMemo(
    () => recoveryMonthTotals(detail.dealers, (d) => valFor(d.dealerId), "sumOfRatios"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.dealers, values, adminMode, adminEdits],
  );

  // Excel-style column sections — follows the handwritten business workflow EXACTLY (visual only).
  // Dealer(frozen) → Outstanding → Overdue → Due → Recovery Plan → Running O/S Bills →
  // Running Recovery Plan → Recovery % → Results.
  // "Total Recovery Plan" (Results, purple) now sits immediately AFTER "Recovery %" — i.e. right after the
  // green Recovery Progress block — instead of at the far right. The trailing No-Plan action column (when
  // editable) is intentionally left outside any coloured section band.
  const monthSections: LabelSection[] = [
    { labelKey: "recovery.section.dealerClosing", span: 2, tone: "blue" },
    { labelKey: "recovery.section.recoveryPlanning", span: 3, tone: "amber" },
    { labelKey: "recovery.section.recoveryProgress", span: 4, tone: "green" },
    { labelKey: "recovery.section.results", span: 1, tone: "purple" },
    { labelKey: "recovery.section.daybook", span: 3, tone: "slate" },
  ];

  return (
    <div className="space-y-2">
      {canAdminEdit && !adminMode && (
        <div className="flex justify-end"><EditPlanButton onClick={enterAdminMode} /></div>
      )}
      {adminMode && <AdminEditBar onDone={() => setReviewOpen(true)} onCancel={cancelAdminMode} disabled={adminSaving} />}
      <ChangeReviewDialog
        open={reviewOpen}
        title={`Recovery Plan · ${detail.officerName} · Month`}
        subtitle={`${detail.seasonName} · ${detail.monthName}`}
        changes={adminMode ? adminChanges() : []}
        saving={adminSaving}
        error={adminError}
        onConfirm={(reason) => { void adminSave(reason); }}
        onClose={() => setReviewOpen(false)}
      />
      {editable && (
        <div className="flex items-center justify-end gap-3 text-sm text-muted-foreground">
          <span>{saving ? "Saving…" : "Saved"}</span>
          <Button size="sm" variant="outline" onClick={() => flush()} disabled={saving}><Save className="h-4 w-4" /> Save</Button>
        </div>
      )}
      <div className="overflow-auto rounded-lg border bg-background">
        <Table stickyFirstColumn>
          {/* Excel-style sections (visual only — column ORDER reflows to the business layout; data,
              fields and calculations are unchanged). */}
          <SectionColgroup leading={1} sections={monthSections} />
          <TableHeader>
            <LabelSectionHeaderRow leading={1} sections={monthSections} />
            <TableRow>
              <Th labelKey="col.dealer" className="min-w-[160px]" />
              <Th labelKey="recovery.currentOutstanding" className="text-right" suffix={<DateSuffix date={cutoffDdMm} />} />
              <Th labelKey="recovery.outstandingTillDate" className="text-right text-muted-foreground" suffix={<DateSuffix date={tillDdMm} />} />
              <Th labelKey="recovery.overdue" className="text-right" />
              <Th labelKey="recovery.due" className="text-right" />
              <Th labelKey="recovery.recoveryPlan" className="text-center" />
              <Th labelKey="recovery.runningOsBills" className="text-right" />
              <Th labelKey="recovery.runningOsTillDate" className="text-right text-muted-foreground" />
              <Th labelKey="recovery.runningRecoveryPlan" className="text-center" />
              <Th labelKey="recovery.recoveryPct" className="text-right" />
              {/* Total Recovery Plan — moved to sit beside Recovery % (purple Results). */}
              <Th labelKey="recovery.monthTotal" className="text-right" />
              <Th labelKey="recovery.srCr" className="text-right text-muted-foreground" />
              <Th labelKey="recovery.liveRecovery" className="text-right text-muted-foreground" />
              <Th labelKey="recovery.actualRunningRecovery" className="text-right" />
              {editable && <Th labelKey="col.noPlan" className="text-right" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.dealers.map((d) => {
              const v = valFor(d.dealerId);
              const monthTotal = v.plan + v.running;
              const recPct = d.running > 0 ? v.running / d.running : 0;
              const status = d.noPlan ? DealerPlanningStatus.NO_PLAN : monthTotal > 0 ? DealerPlanningStatus.COMPLETED : DealerPlanningStatus.REMAINING;
              return (
                <TableRow key={d.dealerId} className={cn(d.noPlan && "opacity-60", d.changed && "bg-amber-100/40 dark:bg-amber-900/15")}>
                  <TableCell className="font-medium" style={{ color: status === DealerPlanningStatus.COMPLETED ? "hsl(var(--success))" : status === DealerPlanningStatus.NO_PLAN ? "hsl(var(--noplan))" : undefined }}>
                    {status === DealerPlanningStatus.COMPLETED ? "✓ " : status === DealerPlanningStatus.NO_PLAN ? "⦸ " : ""}{d.dealerName}
                    {d.missingInLatestAging && <span className="ml-1.5 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning" title="This dealer is not in the latest Aging Report; the figures shown are the last known values.">Missing in latest aging</span>}
                  </TableCell>
                  {/* Section 1 — Dealer & Closing Balance. Current Outstanding KEEPS its amount change
                      delta; Outstanding Till Date is the month's opening balance (frozen after first import). */}
                  <TableCell className="text-right"><AgingCell value={d.outstanding} prev={d.prevAging?.outstanding} /></TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{money(d.outstandingTillDate)}</TableCell>
                  {/* Section 2 — Recovery Planning. Delta indicators removed (kept only on Current Outstanding
                      and Actual Running Recovery). */}
                  <TableCell className="text-right tabular-nums">{money(d.overdue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.due)}</TableCell>
                  <TableCell className="p-1 text-center">
                    <Input type="number" min={0} className="h-8 w-24 text-right" value={v.plan === 0 ? "" : v.plan} placeholder="0" disabled={(!editable && !adminMode) || d.noPlan} onChange={(e) => set(d.dealerId, "plan", e.target.value)} />
                  </TableCell>
                  {/* Section 3 — Recovery Progress. Running O/S Till Date is frozen after first import. */}
                  <TableCell className="text-right tabular-nums">{money(d.running)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{money(d.runningTillDate)}</TableCell>
                  <TableCell className="p-1 text-center">
                    <Input type="number" min={0} className="h-8 w-24 text-right" value={v.running === 0 ? "" : v.running} placeholder="0" disabled={(!editable && !adminMode) || d.noPlan} onChange={(e) => set(d.dealerId, "running", e.target.value)} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{pct(recPct)}</TableCell>
                  {/* Total Recovery Plan (purple Results) — moved to sit beside Recovery %. */}
                  <TableCell className="text-right tabular-nums font-medium">{money(monthTotal)}</TableCell>
                  {/* Daybook-derived business values. Actual Running Recovery is DERIVED (Part 5):
                      Live Recovery + SR/CR − (Due + Overdue). Its VALUE is unchanged; the badge shows ARR as
                      a percentage of the Running Recovery Plan (green if positive, red if negative). */}
                  <TableCell className="text-right tabular-nums text-muted-foreground">{money(d.srCr)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{money(d.liveRecovery)}</TableCell>
                  <TableCell className="text-right">
                    <div className="text-right tabular-nums">
                      <div className={cn("font-medium", d.actualRunningRecovery < 0 && "text-warning")}>{money(d.actualRunningRecovery)}</div>
                      <PctDelta value={d.actualRunningRecovery} base={d.monthRunningRecovery} />
                    </div>
                  </TableCell>
                  {editable && (
                    <TableCell className="text-right">
                      {d.noPlan ? (
                        <Button size="sm" variant="ghost" onClick={() => noPlanMut.mutate({ dealerId: d.dealerId, noPlan: false })} disabled={noPlanMut.isPending}>Undo</Button>
                      ) : (
                        <Button size="sm" variant="ghost" className="text-noplan" onClick={() => setNoPlanFor(d)}><Ban className="h-4 w-4" /></Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
          <tfoot className="sticky bottom-0 z-[1] bg-muted/40 shadow-[0_-1px_0_hsl(var(--border))]">
            <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
              <TableCell>Total</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.outstanding)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.outstandingTillDate)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.overdue)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.due)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.recoveryPlan)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.runningOs)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.runningOsTillDate)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.runningRecoveryPlan)}</TableCell>
              <TableCell className="text-right tabular-nums">{pct(totals.recoveryPct)}</TableCell>
              {/* Total Recovery Plan — moved beside Recovery %. */}
              <TableCell className="text-right tabular-nums">{money(totals.monthTotal)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.srCr)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.liveRecovery)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.actualRunningRecovery)}</TableCell>
              {editable && <TableCell />}
            </TableRow>
          </tfoot>
        </Table>
      </div>
      {noPlanFor && (
        <NoPlanDialog
          open={!!noPlanFor}
          dealerName={noPlanFor.dealerName}
          onOpenChange={(o) => !o && setNoPlanFor(null)}
          saving={noPlanMut.isPending}
          onConfirm={(reason) => { void flush().then(() => noPlanMut.mutate({ dealerId: noPlanFor.dealerId, noPlan: true, reason })); }}
        />
      )}
    </div>
  );
}

/* -------------------------------- Week View ------------------------------- */

function WeekView({ detail }: { detail: RecoveryDetail }) {
  const qc = useQueryClient();
  const editable = detail.weekEditable;
  // Open on the current business week (later refreshes lock earlier weeks).
  const [weekNo, setWeekNo] = useState(Math.min(Math.max(detail.currentWeek, 1), detail.weekCount));
  const weekOptions = Array.from({ length: detail.weekCount }, (_, i) => ({
    value: String(i + 1),
    label: i + 1 < detail.currentWeek ? `Week ${i + 1} 🔒` : `Week ${i + 1}`,
  }));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Week:</span>
        <NativeSelect className="w-36" options={weekOptions} value={String(weekNo)} onChange={(e) => setWeekNo(Number(e.target.value))} />
        {!editable && <span className="text-xs text-muted-foreground">Week View is locked in this state.</span>}
        {editable && weekNo < detail.currentWeek && (
          <span className="text-xs text-warning">Week {weekNo} is locked — read-only after the Week {detail.currentWeek} refresh. Values are preserved.</span>
        )}
      </div>
      <WeekGrid key={weekNo} detail={detail} weekNo={weekNo} editable={editable} onSaved={() => qc.invalidateQueries({ queryKey: ["recovery-plan", detail.id] })} />
    </div>
  );
}

function WeekGrid({ detail, weekNo, editable, onSaved }: { detail: RecoveryDetail; weekNo: number; editable: boolean; onSaved: () => void }) {
  const initial = useMemo(() => {
    const m: Record<string, { plan: number; running: number }> = {};
    for (const d of detail.dealers) {
      const w = d.weeks[weekNo] ?? { weekRecoveryPlan: 0, weekRunningRecovery: 0 };
      m[d.dealerId] = { plan: w.weekRecoveryPlan, running: w.weekRunningRecovery };
    }
    return m;
  }, [detail, weekNo]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seed = useMemo(() => initial, [detail.id, weekNo]);

  const persist = async (keys: string[], snap: Record<string, { plan: number; running: number }>) => {
    const entries = keys.map((dealerId) => ({ dealerId, weekRecoveryPlan: snap[dealerId]?.plan ?? 0, weekRunningRecovery: snap[dealerId]?.running ?? 0 }));
    await api.patch(`/api/recovery/plans/${detail.id}/week`, { weekNo, entries });
    onSaved();
  };
  const { values, saving, update, flush } = useAutosaveMap<{ plan: number; running: number }>(seed, persist);
  const qc = useQueryClient();
  // Admin Edit Mode overlay (staged, separate from the officer autosave path).
  const canAdminEdit = !!detail.canAdminEdit;
  const [adminMode, setAdminMode] = useState(false);
  const [adminEdits, setAdminEdits] = useState<Record<string, { plan: number; running: number }>>({});
  const [adminSaving, setAdminSaving] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const valFor = (dealerId: string) => (adminMode ? adminEdits[dealerId] ?? initial[dealerId] ?? { plan: 0, running: 0 } : values[dealerId] ?? { plan: 0, running: 0 });
  const set = (dealerId: string, field: "plan" | "running", raw: string) => {
    const n = Math.max(0, Number(raw) || 0);
    if (adminMode) {
      setAdminEdits((prev) => { const cur = prev[dealerId] ?? initial[dealerId] ?? { plan: 0, running: 0 }; return { ...prev, [dealerId]: { ...cur, [field]: n } }; });
      return;
    }
    const cur = values[dealerId] ?? { plan: 0, running: 0 };
    update(dealerId, { ...cur, [field]: n });
  };
  const enterAdminMode = () => { setAdminEdits(initial); setAdminError(null); setAdminMode(true); };
  const cancelAdminMode = () => { setAdminMode(false); setAdminEdits({}); setAdminError(null); };
  const adminChanges = () => {
    const out: { dealerName: string; fieldName: string; oldValue: number; newValue: number }[] = [];
    for (const d of detail.dealers) {
      const base = initial[d.dealerId] ?? { plan: 0, running: 0 };
      const cur = adminEdits[d.dealerId] ?? base;
      if (base.plan !== cur.plan) out.push({ dealerName: d.dealerName, fieldName: `Week ${weekNo} Recovery Plan`, oldValue: base.plan, newValue: cur.plan });
      if (base.running !== cur.running) out.push({ dealerName: d.dealerName, fieldName: `Week ${weekNo} Running Recovery`, oldValue: base.running, newValue: cur.running });
    }
    return out;
  };
  const adminSave = async (reason: string) => {
    const entries: { dealerId: string; weekRecoveryPlan: number; weekRunningRecovery: number }[] = [];
    for (const d of detail.dealers) {
      const base = initial[d.dealerId] ?? { plan: 0, running: 0 };
      const cur = adminEdits[d.dealerId] ?? base;
      if (base.plan !== cur.plan || base.running !== cur.running) entries.push({ dealerId: d.dealerId, weekRecoveryPlan: cur.plan, weekRunningRecovery: cur.running });
    }
    setAdminSaving(true); setAdminError(null);
    try {
      await api.post(`/api/recovery/plans/${detail.id}/admin-edit`, { view: "week", weekNo, entries, reason });
      qc.invalidateQueries({ queryKey: ["recovery-plan", detail.id] });
      setAdminMode(false); setAdminEdits({}); setReviewOpen(false);
    } catch (e) { setAdminError((e as Error).message); }
    finally { setAdminSaving(false); }
  };
  // Live-edit resolver: the SELECTED week uses the (admin overlay or officer) edit map; other weeks use
  // the stored values. The cumulative helpers come from the shared recovery-calc module.
  const resolveWeek = (d: RecoveryDealer, w: number): RecoveryValue => (w === weekNo ? valFor(d.dealerId) : storedWeek(d, w));
  const allWeeksTotal = (d: RecoveryDealer) => weekAll(d, detail.weekCount, resolveWeek);
  const tillDateTotal = (d: RecoveryDealer) => weekTillDate(d, weekNo, resolveWeek);

  // Week locking: weeks BEFORE the latest cutoff's business week are read-only. Values stay filled;
  // only editing is disabled (the officer adjusts the current/later weeks).
  const weekLocked = weekNo < detail.currentWeek;
  const canEditWeek = editable && !weekLocked;

  // This footer follows the same live values as the inputs. It is a view calculation only and
  // therefore never becomes part of a save request.
  const totals = useMemo(
    () => recoveryWeekTotals(detail.dealers, resolveWeek, weekNo, detail.weekCount),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.dealers, values, weekNo, adminMode, adminEdits],
  );

  // Excel-style column sections — follows the handwritten business workflow EXACTLY (visual only).
  // The Reference section keeps informational balances out of the primary planning flow.
  // Dealer & Closing now spans 2 (Current Outstanding + Outstanding Till Date, matching Month View).
  const weekSections: LabelSection[] = [
    { labelKey: "recovery.section.dealerClosing", span: 2, tone: "blue" },
    { labelKey: "recovery.section.weeklyPlanning", span: 3, tone: "amber" },
    { labelKey: "recovery.section.recoveryProgress", span: 3, tone: "green" },
    { labelKey: "recovery.section.results", span: 2, tone: "purple" },
  ];
  // Dynamic column dates (same derivation as Month View).
  const cutoffDdMm = ddmm(detail.cutoffDate);
  const tillDdMm = monthFirstDdMm(detail.cutoffDate);
  const totalOutstandingTillDate = detail.dealers.reduce((s, d) => s + d.outstandingTillDate, 0);

  return (
    <div className="space-y-2">
      {canAdminEdit && !adminMode && (
        <div className="flex justify-end"><EditPlanButton onClick={enterAdminMode} /></div>
      )}
      {adminMode && <AdminEditBar onDone={() => setReviewOpen(true)} onCancel={cancelAdminMode} disabled={adminSaving} />}
      <ChangeReviewDialog
        open={reviewOpen}
        title={`Recovery Plan · ${detail.officerName} · Week ${weekNo}`}
        subtitle={`${detail.seasonName} · ${detail.monthName}`}
        changes={adminMode ? adminChanges() : []}
        saving={adminSaving}
        error={adminError}
        onConfirm={(reason) => { void adminSave(reason); }}
        onClose={() => setReviewOpen(false)}
      />
      {editable && (
        <div className="flex items-center justify-end gap-3 text-sm text-muted-foreground">
          <span>{saving ? "Saving…" : "Saved"}</span>
          <Button size="sm" variant="outline" onClick={() => flush()} disabled={saving}><Save className="h-4 w-4" /> Save</Button>
        </div>
      )}
      <div className="overflow-auto rounded-lg border bg-background">
        <Table stickyFirstColumn>
          {/* Excel-style sections (visual grouping only — columns, data and calculations unchanged). */}
          <SectionColgroup leading={1} sections={weekSections} />
          <TableHeader>
            <LabelSectionHeaderRow leading={1} sections={weekSections} />
            <TableRow>
              <Th labelKey="col.dealer" className="min-w-[160px]" />
              <Th labelKey="recovery.currentOutstanding" className="text-right" suffix={<DateSuffix date={cutoffDdMm} />} />
              <Th labelKey="recovery.outstandingTillDate" className="text-right text-muted-foreground" suffix={<DateSuffix date={tillDdMm} />} />
              <Th labelKey="recovery.overdue" className="text-right" />
              <Th labelKey="recovery.thisWeeksDue" className="text-right" />
              <Th labelKey="recovery.weekRecovery" className="text-center" />
              <Th labelKey="recovery.runningMonthPlan" className="text-right text-muted-foreground" />
              <Th labelKey="recovery.weeklyPlanTillDate" className="text-right" />
              <Th labelKey="recovery.runningPlanThisWeek" className="text-center" />
              <Th labelKey="recovery.thisWeekTotal" className="text-right" />
              <Th labelKey="recovery.diff" className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.dealers.map((d) => {
              const v = valFor(d.dealerId);
              const weekTotal = v.plan + v.running;
              const monthTotal = d.monthRecoveryPlan + d.monthRunningRecovery;
              const diff = monthTotal - allWeeksTotal(d);
              const tillDate = tillDateTotal(d);
              return (
                <TableRow key={d.dealerId} className={cn(d.noPlan && "opacity-60", d.changed && "bg-amber-100/40 dark:bg-amber-900/15")}>
                  <TableCell className="font-medium">{d.dealerName}</TableCell>
                  {/* Section 1 — Dealer & Closing Balance. Current Outstanding keeps its delta; Outstanding
                      Till Date (same calc as Month View) added beside it. */}
                  <TableCell className="text-right"><AgingCell value={d.outstanding} prev={d.prevAging?.outstanding} /></TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{money(d.outstandingTillDate)}</TableCell>
                  {/* Section 2 — Weekly Planning. "This Week's Due" = only invoices due in the
                      SELECTED business week (not the whole month's Due). Delta removed from Overdue. */}
                  <TableCell className="text-right tabular-nums">{money(d.overdue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.dueByWeek?.[weekNo] ?? 0)}</TableCell>
                  <TableCell className="p-1 text-center">
                    <Input type="number" min={0} className="h-8 w-24 text-right" value={v.plan === 0 ? "" : v.plan} placeholder="0" disabled={(!canEditWeek && !adminMode) || d.noPlan} onChange={(e) => set(d.dealerId, "plan", e.target.value)} />
                  </TableCell>
                  {/* Section 3 — Recovery Progress */}
                  {/* "Running Plan Month" is the Month View's Running Recovery Plan. Labels are
                      configurable, but the stable business field is monthRunningRecovery. */}
                  <TableCell className="text-right tabular-nums text-muted-foreground">{money(d.monthRunningRecovery)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{money(tillDate)}</TableCell>
                  <TableCell className="p-1 text-center">
                    <Input type="number" min={0} className="h-8 w-24 text-right" value={v.running === 0 ? "" : v.running} placeholder="0" disabled={(!canEditWeek && !adminMode) || d.noPlan} onChange={(e) => set(d.dealerId, "running", e.target.value)} />
                  </TableCell>
                  {/* Section 4 — Results */}
                  <TableCell className="text-right tabular-nums font-medium">{money(weekTotal)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", diff !== 0 && "text-warning")}>{money(diff)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <tfoot className="sticky bottom-0 z-[1] bg-muted/40 shadow-[0_-1px_0_hsl(var(--border))]">
            <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
              <TableCell>Total</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.outstanding)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totalOutstandingTillDate)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.overdue)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.due)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.recoveryPlan)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.runningMonthPlan)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.weeklyPlanTillDate)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.runningPlanThisWeek)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.weekTotal)}</TableCell>
              <TableCell className={cn("text-right tabular-nums", totals.diff !== 0 && "text-warning")}>{money(totals.diff)}</TableCell>
            </TableRow>
          </tfoot>
        </Table>
      </div>
    </div>
  );
}
