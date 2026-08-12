"use client";

import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ChevronRight, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency } from "@/lib/utils";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  recoveryMonthTotals, recoveryWeekTotals, weekTillDate, weekAll, storedMonth, storedWeek,
  type RecoveryCalcDealer, type RecoveryMonthTotals, type RecoveryWeekTotals,
} from "@/features/recovery/recovery-calc";
import {
  StatusFilter, OfficersBadge, BUCKET_LABEL,
  type StatusBucket, type GroupOfficerBreakdown,
} from "./group-plan-page";

/* --------------------------------- Types ---------------------------------- */

interface TerritoryDealer extends RecoveryCalcDealer { dealerName: string }
interface RecoveryOfficerRow { officerId: string; officerName: string; bucket: StatusBucket; status: string; recoveryPlanId: string; dealers: TerritoryDealer[] }
interface GroupRecoveryData {
  groupName: string; seasonName: string; monthName: string; seasonMonthId: string; weekCount: number;
  months: { id: string; name: string; order: number }[];
  filter: { buckets: StatusBucket[]; seasonMonthId: string };
  officers: GroupOfficerBreakdown;
  rows: RecoveryOfficerRow[];
}

type RView = "month" | "week";
const money = (n: number) => formatCurrency(n);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/* Column configs — reused for the table header/footer AND the drawer. Values come ONLY from the shared
 * recovery-calc, so a dealer's numbers and the officer total are the same math the Recovery table uses. */
interface Col<T> { label: string; total: (t: T) => number; dealer: (d: TerritoryDealer) => number; pct?: boolean }

const MONTH_COLS: Col<RecoveryMonthTotals>[] = [
  { label: "Current Outstanding", total: (t) => t.outstanding, dealer: (d) => d.outstanding },
  { label: "Outstanding Till Date", total: (t) => t.outstandingTillDate, dealer: (d) => d.outstandingTillDate },
  { label: "Overdue", total: (t) => t.overdue, dealer: (d) => d.overdue },
  { label: "Due", total: (t) => t.due, dealer: (d) => d.due },
  { label: "Recovery Plan", total: (t) => t.recoveryPlan, dealer: (d) => d.monthRecoveryPlan },
  { label: "Running O/S Bills", total: (t) => t.runningOs, dealer: (d) => d.running },
  { label: "Running O/S Till Date", total: (t) => t.runningOsTillDate, dealer: (d) => d.runningTillDate },
  { label: "Running Recovery Plan", total: (t) => t.runningRecoveryPlan, dealer: (d) => d.monthRunningRecovery },
  { label: "Recovery %", total: (t) => t.recoveryPct, dealer: (d) => (d.running > 0 ? d.monthRunningRecovery / d.running : 0), pct: true },
  { label: "SR/CR", total: (t) => t.srCr, dealer: (d) => d.srCr },
  { label: "Live Recovery", total: (t) => t.liveRecovery, dealer: (d) => d.liveRecovery },
  { label: "Actual Running Recovery", total: (t) => t.actualRunningRecovery, dealer: (d) => d.actualRunningRecovery },
  { label: "Month Total", total: (t) => t.monthTotal, dealer: (d) => d.monthRecoveryPlan + d.monthRunningRecovery },
];

const weekCols = (weekNo: number, weekCount: number): Col<RecoveryWeekTotals>[] => [
  { label: "Outstanding", total: (t) => t.outstanding, dealer: (d) => d.outstanding },
  { label: "Overdue", total: (t) => t.overdue, dealer: (d) => d.overdue },
  { label: "Due (this week)", total: (t) => t.due, dealer: (d) => d.dueByWeek?.[weekNo] ?? 0 },
  { label: "Recovery Plan", total: (t) => t.recoveryPlan, dealer: (d) => storedWeek(d, weekNo).plan },
  { label: "Running Month Plan", total: (t) => t.runningMonthPlan, dealer: (d) => d.monthRunningRecovery },
  { label: "Weekly Plan Till Date", total: (t) => t.weeklyPlanTillDate, dealer: (d) => weekTillDate(d, weekNo, storedWeek) },
  { label: "Running Plan This Week", total: (t) => t.runningPlanThisWeek, dealer: (d) => storedWeek(d, weekNo).running },
  { label: "Week Total", total: (t) => t.weekTotal, dealer: (d) => storedWeek(d, weekNo).plan + storedWeek(d, weekNo).running },
  { label: "Diff", total: (t) => t.diff, dealer: (d) => d.monthRecoveryPlan + d.monthRunningRecovery - weekAll(d, weekCount, storedWeek) },
];

/* ------------------------------- Component -------------------------------- */

/**
 * Territory Recovery — READ-ONLY. One row per Sales Officer = the aggregate of that officer's dealers,
 * for the selected Season → Month, view (Month/Week) and Plan-Status buckets. The per-officer and grand
 * totals are computed by the SHARED recovery-calc (same math as the per-officer Recovery table); the
 * drawer shows the same dealers un-aggregated, so its numbers always equal the row.
 */
export function GroupRecovery({ groupId, seasonId }: { groupId: string; seasonId: string }) {
  const [month, setMonth] = useState("");
  const [view, setView] = useState<RView>("month");
  const [weekNo, setWeekNo] = useState(1);
  const [buckets, setBuckets] = useState<StatusBucket[]>(["approved", "submitted", "draft"]);
  const [drawer, setDrawer] = useState<RecoveryOfficerRow | null>(null);

  const bucketsKey = [...buckets].sort().join(",");
  const { data, isLoading, isFetching } = useQuery<GroupRecoveryData>({
    queryKey: ["group-recovery", groupId, seasonId, month, bucketsKey],
    queryFn: () => api.get(`/api/planning/groups/${groupId}/recovery?seasonId=${seasonId}&month=${month}&buckets=${bucketsKey || "approved"}`),
    enabled: !!seasonId,
    placeholderData: keepPreviousData,
  });

  const months = data?.months ?? [];
  const monthValue = month || data?.seasonMonthId || "";
  const weekCount = data?.weekCount ?? 4;

  const toggleBucket = (b: StatusBucket) =>
    setBuckets((prev) => {
      const next = prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b];
      return next.length ? next : prev;
    });

  // Grand total across every included officer's dealers — one shared-calc pass over all dealers.
  const allDealers = useMemo(() => (data?.rows ?? []).flatMap((r) => r.dealers), [data?.rows]);
  const grandMonth = useMemo(() => recoveryMonthTotals(allDealers, storedMonth, "ratioOfSums"), [allDealers]);
  const grandWeek = useMemo(() => recoveryWeekTotals(allDealers, storedWeek, weekNo, weekCount), [allDealers, weekNo, weekCount]);

  if (!seasonId) return <p className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">Choose a season to view Territory Recovery.</p>;
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const cols: Col<RecoveryMonthTotals>[] | Col<RecoveryWeekTotals>[] = view === "month" ? MONTH_COLS : weekCols(weekNo, weekCount);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter buckets={buckets} onToggle={toggleBucket} />
        <OfficersBadge officers={data.officers} />
        <span className="text-sm text-muted-foreground">·</span>
        <span className="text-sm text-muted-foreground">{data.seasonName} · {data.monthName}</span>
        {isFetching && <span className="text-xs text-muted-foreground">updating…</span>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Month</span>
          <NativeSelect className="w-40" options={months.map((m) => ({ value: m.id, label: m.name }))} value={monthValue} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
          {(["month", "week"] as RView[]).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cn("rounded px-3 py-1.5 font-medium", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
              {v === "month" ? "Month View" : "Week View"}
            </button>
          ))}
        </div>
        {view === "week" && (
          <NativeSelect
            className="w-32"
            options={Array.from({ length: weekCount }, (_, i) => ({ value: String(i + 1), label: `Week ${i + 1}` }))}
            value={String(weekNo)}
            onChange={(e) => setWeekNo(Number(e.target.value))}
          />
        )}
      </div>

      {data.rows.length === 0 ? (
        <div className="rounded-lg border bg-background p-10 text-center text-sm text-muted-foreground">No recovery plans for this group, month and selected states.</div>
      ) : (
        <div className="overflow-auto rounded-lg border bg-background">
          <Table stickyFirstColumn>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[180px]">Sales Officer</TableHead>
                {cols.map((c) => <TableHead key={c.label} className="text-right">{c.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => {
                const t = view === "month"
                  ? recoveryMonthTotals(r.dealers, storedMonth, "ratioOfSums")
                  : recoveryWeekTotals(r.dealers, storedWeek, weekNo, weekCount);
                return (
                  <TableRow key={r.officerId}>
                    <TableCell className="font-medium">
                      <button className="inline-flex items-center gap-1 text-left text-primary hover:underline" onClick={() => setDrawer(r)}>
                        {r.officerName} <ChevronRight className="h-3.5 w-3.5" />
                        <span className="ml-1 text-[10px] font-normal text-muted-foreground">{BUCKET_LABEL[r.bucket]}</span>
                      </button>
                    </TableCell>
                    {(cols as Col<typeof t>[]).map((c) => (
                      <TableCell key={c.label} className="text-right tabular-nums">{c.pct ? pct(c.total(t)) : money(c.total(t))}</TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
            <tfoot>
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell>Total</TableCell>
                {(cols as Col<RecoveryMonthTotals & RecoveryWeekTotals>[]).map((c) => {
                  const t = (view === "month" ? grandMonth : grandWeek) as RecoveryMonthTotals & RecoveryWeekTotals;
                  return <TableCell key={c.label} className="text-right tabular-nums">{c.pct ? pct(c.total(t)) : money(c.total(t))}</TableCell>;
                })}
              </TableRow>
            </tfoot>
          </Table>
        </div>
      )}

      {drawer && (
        <OfficerRecoveryDrawer
          row={drawer}
          view={view}
          weekNo={weekNo}
          weekCount={weekCount}
          filterLabel={`${data.seasonName} · ${data.monthName} · ${view === "month" ? "Month" : `Week ${weekNo}`} · ${buckets.map((b) => BUCKET_LABEL[b]).join(", ")}`}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

/* --------------------------------- Drawer --------------------------------- */

function OfficerRecoveryDrawer({ row, view, weekNo, weekCount, filterLabel, onClose }: { row: RecoveryOfficerRow; view: RView; weekNo: number; weekCount: number; filterLabel: string; onClose: () => void }) {
  const [openDealer, setOpenDealer] = useState<string | null>(null);
  const cols: Col<RecoveryMonthTotals>[] | Col<RecoveryWeekTotals>[] = view === "month" ? MONTH_COLS : weekCols(weekNo, weekCount);
  const totals = view === "month"
    ? recoveryMonthTotals(row.dealers, storedMonth, "ratioOfSums")
    : recoveryWeekTotals(row.dealers, storedWeek, weekNo, weekCount);

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-lg flex-col border-l bg-background shadow-xl">
        <div className="flex items-start justify-between border-b p-4">
          <div>
            <h2 className="text-base font-semibold">{row.officerName}</h2>
            <p className="text-xs text-muted-foreground">{filterLabel}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>

        {/* Officer summary — the same totals shown on the officer's row. */}
        <div className="border-b bg-muted/30 p-4">
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Officer Summary</div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            {(cols as Col<typeof totals>[]).map((c) => (
              <div key={c.label} className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">{c.label}</dt>
                <dd className="tabular-nums font-medium">{c.pct ? pct(c.total(totals)) : money(c.total(totals))}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Dealer breakdown — each dealer collapsible; values are the same-view per-dealer figures. */}
        <div className="flex-1 overflow-auto p-3">
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Dealer Breakdown ({row.dealers.length})</div>
          {row.dealers.map((d) => (
            <div key={d.dealerId} className="mb-2 rounded-md border">
              <button className="flex w-full items-center justify-between gap-2 p-2.5 text-left" onClick={() => setOpenDealer((x) => (x === d.dealerId ? null : d.dealerId))}>
                <span className="flex items-center gap-1.5 font-medium">
                  <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", openDealer === d.dealerId && "rotate-90")} />
                  {d.dealerName}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">O/S {money(d.outstanding)}</span>
              </button>
              {openDealer === d.dealerId && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t bg-muted/20 p-3 text-xs">
                  {(cols as Col<typeof totals>[]).map((c) => (
                    <div key={c.label} className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">{c.label}</dt>
                      <dd className="tabular-nums text-foreground">{c.pct ? pct(c.dealer(d)) : money(c.dealer(d))}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
