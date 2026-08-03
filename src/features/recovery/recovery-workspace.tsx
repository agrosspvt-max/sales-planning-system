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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/features/planning/status-badge";
import { DealerProgressBar, NoPlanDialog, type StatusCounts } from "@/features/planning/dealer-completion";
import { DealerPlanningStatus } from "@/features/planning/dealer-status";
import { useAutosaveMap } from "@/features/planning/use-autosave-map";
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
  monthRecoveryPlan: number;
  monthRunningRecovery: number;
  noPlan: boolean;
  noPlanReason: string | null;
  completed: boolean;
  weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }>;
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
  weekCount: number;
  dealers: RecoveryDealer[];
}

type Tab = "month" | "week" | "history";
const money = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n));
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

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
      {tab === "history" && <RecoveryHistory id={id} />}
    </div>
  );
}

/* ------------------------------- Month View ------------------------------- */

function MonthView({ detail }: { detail: RecoveryDetail }) {
  const qc = useQueryClient();
  const editable = detail.monthEditable;

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

  const set = (dealerId: string, field: "plan" | "running", raw: string) => {
    const cur = values[dealerId] ?? { plan: 0, running: 0 };
    update(dealerId, { ...cur, [field]: Math.max(0, Number(raw) || 0) });
  };
  const weeklyTotal = (d: RecoveryDealer) => Object.values(d.weeks).reduce((s, w) => s + w.weekRecoveryPlan + w.weekRunningRecovery, 0);

  return (
    <div className="space-y-2">
      {editable && (
        <div className="flex items-center justify-end gap-3 text-sm text-muted-foreground">
          <span>{saving ? "Saving…" : "Saved"}</span>
          <Button size="sm" variant="outline" onClick={() => flush()} disabled={saving}><Save className="h-4 w-4" /> Save</Button>
        </div>
      )}
      <div className="overflow-auto rounded-lg border bg-background">
        <Table stickyFirstColumn>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[160px]">Dealer</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead className="text-right">Overdue</TableHead>
              <TableHead className="text-right">Due</TableHead>
              <TableHead className="text-right">Running O/S</TableHead>
              <TableHead className="text-center">Recovery Plan</TableHead>
              <TableHead className="text-center">Running Recovery</TableHead>
              <TableHead className="text-right">Recovery %</TableHead>
              <TableHead className="text-right">Month Total</TableHead>
              <TableHead className="text-right text-muted-foreground">Weekly Total</TableHead>
              <TableHead className="text-right">Diff</TableHead>
              {editable && <TableHead className="text-right">No Plan</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.dealers.map((d) => {
              const v = values[d.dealerId] ?? { plan: 0, running: 0 };
              const monthTotal = v.plan + v.running;
              const recPct = d.running > 0 ? v.running / d.running : 0;
              const wTotal = weeklyTotal(d);
              const status = d.noPlan ? DealerPlanningStatus.NO_PLAN : monthTotal > 0 ? DealerPlanningStatus.COMPLETED : DealerPlanningStatus.REMAINING;
              return (
                <TableRow key={d.dealerId} className={cn(d.noPlan && "opacity-60")}>
                  <TableCell className="font-medium" style={{ color: status === DealerPlanningStatus.COMPLETED ? "hsl(var(--success))" : status === DealerPlanningStatus.NO_PLAN ? "hsl(var(--noplan))" : undefined }}>
                    {status === DealerPlanningStatus.COMPLETED ? "✓ " : status === DealerPlanningStatus.NO_PLAN ? "⦸ " : ""}{d.dealerName}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.outstanding)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.overdue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.due)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.running)}</TableCell>
                  <TableCell className="p-1 text-center">
                    <Input type="number" min={0} className="h-8 w-24 text-right" value={v.plan === 0 ? "" : v.plan} placeholder="0" disabled={!editable || d.noPlan} onChange={(e) => set(d.dealerId, "plan", e.target.value)} />
                  </TableCell>
                  <TableCell className="p-1 text-center">
                    <Input type="number" min={0} className="h-8 w-24 text-right" value={v.running === 0 ? "" : v.running} placeholder="0" disabled={!editable || d.noPlan} onChange={(e) => set(d.dealerId, "running", e.target.value)} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{pct(recPct)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{money(monthTotal)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{money(wTotal)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", monthTotal - wTotal !== 0 && "text-warning")}>{money(monthTotal - wTotal)}</TableCell>
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
  const [weekNo, setWeekNo] = useState(1);
  const weekOptions = Array.from({ length: detail.weekCount }, (_, i) => ({ value: String(i + 1), label: `Week ${i + 1}` }));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Week:</span>
        <NativeSelect className="w-32" options={weekOptions} value={String(weekNo)} onChange={(e) => setWeekNo(Number(e.target.value))} />
        {!editable && <span className="text-xs text-muted-foreground">Week View is locked in this state.</span>}
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
  const set = (dealerId: string, field: "plan" | "running", raw: string) => {
    const cur = values[dealerId] ?? { plan: 0, running: 0 };
    update(dealerId, { ...cur, [field]: Math.max(0, Number(raw) || 0) });
  };
  const allWeeksTotal = (d: RecoveryDealer, dealerId: string) => {
    let t = 0;
    for (let w = 1; w <= detail.weekCount; w++) {
      if (w === weekNo) { const v = values[dealerId] ?? { plan: 0, running: 0 }; t += v.plan + v.running; }
      else { const wk = d.weeks[w]; if (wk) t += wk.weekRecoveryPlan + wk.weekRunningRecovery; }
    }
    return t;
  };

  return (
    <div className="space-y-2">
      {editable && (
        <div className="flex items-center justify-end gap-3 text-sm text-muted-foreground">
          <span>{saving ? "Saving…" : "Saved"}</span>
          <Button size="sm" variant="outline" onClick={() => flush()} disabled={saving}><Save className="h-4 w-4" /> Save</Button>
        </div>
      )}
      <div className="overflow-auto rounded-lg border bg-background">
        <Table stickyFirstColumn>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[160px]">Dealer</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead className="text-right">Overdue</TableHead>
              <TableHead className="text-right">Due</TableHead>
              <TableHead className="text-right">Running O/S</TableHead>
              <TableHead className="text-right text-muted-foreground">Recovery Plan</TableHead>
              <TableHead className="text-right text-muted-foreground">Running Recovery</TableHead>
              <TableHead className="text-center">Week Recovery</TableHead>
              <TableHead className="text-center">Week Running</TableHead>
              <TableHead className="text-right">Week Total</TableHead>
              <TableHead className="text-right">Diff</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.dealers.map((d) => {
              const v = values[d.dealerId] ?? { plan: 0, running: 0 };
              const weekTotal = v.plan + v.running;
              const monthTotal = d.monthRecoveryPlan + d.monthRunningRecovery;
              const diff = monthTotal - allWeeksTotal(d, d.dealerId);
              return (
                <TableRow key={d.dealerId} className={cn(d.noPlan && "opacity-60")}>
                  <TableCell className="font-medium">{d.dealerName}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.outstanding)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.overdue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.due)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.running)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{money(d.monthRecoveryPlan)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{money(d.monthRunningRecovery)}</TableCell>
                  <TableCell className="p-1 text-center">
                    <Input type="number" min={0} className="h-8 w-24 text-right" value={v.plan === 0 ? "" : v.plan} placeholder="0" disabled={!editable || d.noPlan} onChange={(e) => set(d.dealerId, "plan", e.target.value)} />
                  </TableCell>
                  <TableCell className="p-1 text-center">
                    <Input type="number" min={0} className="h-8 w-24 text-right" value={v.running === 0 ? "" : v.running} placeholder="0" disabled={!editable || d.noPlan} onChange={(e) => set(d.dealerId, "running", e.target.value)} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{money(weekTotal)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", diff !== 0 && "text-warning")}>{money(diff)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
