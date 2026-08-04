"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { RefreshCw, UploadCloud } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { TimelineItem } from "@/features/planning/types";

const ACTION_LABELS: Record<string, string> = { SUBMIT: "Submitted", RECALL: "Recalled", APPROVE: "Approved", RETURN: "Returned", REJECT: "Rejected" };
const money = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n));

interface AgingSummary {
  outstandingIncreased: number;
  outstandingDecreased: number;
  newDealers: number;
  removedDealers: number;
  outstandingDelta: number;
}
interface Snapshot {
  id: string;
  weekNo: number;
  businessWeek: number;
  initial: boolean;
  cutoffDate: string;
  workbookName: string;
  uploadedBy: string;
  createdAt: string;
  summary: AgingSummary | null;
}
type Metrics = { outstanding: number; overdue: number; due: number; running: number };
interface Comparison {
  totals: { from: Metrics; to: Metrics };
  dealers: { dealerId: string; dealerName: string; from: Metrics; to: Metrics }[];
}

/** Business-aware delta: for receivables a DECREASE is good (green), an increase is bad (red). */
function DeltaSpan({ value }: { value: number }) {
  if (Math.round(value) === 0) return <span className="text-muted-foreground">±0</span>;
  const good = value < 0;
  return <span className={good ? "text-success" : "text-destructive"}>{good ? "▼" : "▲"} {value < 0 ? "-" : "+"}{money(Math.abs(value))}</span>;
}

export function RecoveryHistory({ id, role }: { id: string; role: Role }) {
  const isAdmin = role === Role.SUPER_ADMIN;
  const { data: timeline, isLoading: tLoading } = useQuery<{ items: Snapshot[] }>({
    queryKey: ["recovery-timeline", id],
    queryFn: () => api.get(`/api/recovery/plans/${id}/timeline`),
  });
  const { data: approvals, isLoading: aLoading } = useQuery<{ timeline: TimelineItem[] }>({
    queryKey: ["recovery-history", id],
    queryFn: () => api.get(`/api/recovery/plans/${id}/history`),
  });

  return (
    <div className="space-y-6">
      {/* ---- Recovery (aging refresh) timeline ---- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Recovery Timeline</h3>
        {tLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (timeline?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No aging snapshots yet.</p>
        ) : (
          <ol className="space-y-4 border-l pl-4">
            {timeline!.items.map((s) => (
              <li key={s.id} className="relative">
                <span className={cn("absolute -left-[21px] top-1 flex h-4 w-4 items-center justify-center rounded-full", s.initial ? "bg-primary" : "bg-info")}>
                  {s.initial ? <UploadCloud className="h-2.5 w-2.5 text-primary-foreground" /> : <RefreshCw className="h-2.5 w-2.5 text-info-foreground" />}
                </span>
                <div className="text-sm">
                  <span className="font-medium">Week {s.businessWeek}</span>
                  <span className="ml-2 text-muted-foreground">{s.initial ? "Initial Upload" : "Updated Aging"}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{formatDate(s.cutoffDate)} · by {s.uploadedBy}</span>
                </div>
                <p className="text-xs text-muted-foreground">{s.workbookName}</p>
                {s.summary && (
                  <p className="text-xs">
                    Outstanding <DeltaSpan value={s.summary.outstandingDelta} />
                    {s.summary.newDealers > 0 && <span className="ml-2 text-muted-foreground">+{s.summary.newDealers} new</span>}
                    {s.summary.removedDealers > 0 && <span className="ml-2 text-muted-foreground">−{s.summary.removedDealers} removed</span>}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ---- Admin snapshot comparison ---- */}
      {isAdmin && (timeline?.items.length ?? 0) >= 2 && <SnapshotCompare id={id} snapshots={timeline!.items} />}

      {/* ---- Approval history (unchanged) ---- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Approval History</h3>
        {aLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (approvals?.timeline.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No approval actions yet.</p>
        ) : (
          <ol className="space-y-3 border-l pl-4">
            {approvals!.timeline.map((t) => (
              <li key={t.id} className="relative">
                <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-primary" />
                <div className="text-sm">
                  <span className="font-medium">{ACTION_LABELS[t.action] ?? t.action}</span> by {t.actorName}
                  <span className="ml-2 text-xs text-muted-foreground">{formatDate(t.createdAt)}</span>
                </div>
                {t.remarks && <p className="text-sm text-muted-foreground">“{t.remarks}”</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** Admin-only tool: compare any two aging snapshots of this plan. */
function SnapshotCompare({ id, snapshots }: { id: string; snapshots: Snapshot[] }) {
  const opts = snapshots.map((s) => ({ value: s.id, label: `Week ${s.businessWeek} · ${formatDate(s.cutoffDate)}${s.initial ? " (initial)" : ""}` }));
  const [from, setFrom] = useState(snapshots[snapshots.length - 2]?.id ?? "");
  const [to, setTo] = useState(snapshots[snapshots.length - 1]?.id ?? "");

  const { data, isFetching, refetch } = useQuery<Comparison>({
    queryKey: ["recovery-compare", id, from, to],
    queryFn: () => api.get(`/api/recovery/plans/${id}/compare?from=${from}&to=${to}`),
    enabled: false,
  });

  const rows: { label: string; key: keyof Metrics }[] = [
    { label: "Outstanding", key: "outstanding" },
    { label: "Overdue", key: "overdue" },
    { label: "Due", key: "due" },
    { label: "Running O/S", key: "running" },
  ];

  return (
    <section className="space-y-2 rounded-lg border bg-background p-3">
      <h3 className="text-sm font-semibold">Compare Snapshots</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">From</p>
          <NativeSelect className="w-56" options={opts} value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">To</p>
          <NativeSelect className="w-56" options={opts} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={!from || !to || from === to || isFetching}>Compare</Button>
      </div>
      {data && (
        <div className="grid gap-2 sm:grid-cols-2">
          {rows.map((r) => {
            const f = data.totals.from[r.key];
            const t = data.totals.to[r.key];
            return (
              <div key={r.key} className="rounded-md border p-2 text-sm">
                <p className="text-xs uppercase text-muted-foreground">{r.label}</p>
                <p className="tabular-nums">{money(f)} → {money(t)} <span className="ml-1 text-xs"><DeltaSpan value={t - f} /></span></p>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground sm:col-span-2">{data.dealers.length} dealer(s) changed between these snapshots.</p>
        </div>
      )}
    </section>
  );
}
