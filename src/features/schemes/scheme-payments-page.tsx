"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IndianRupee } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";

/* --------------------------------- API shapes (mirror scheme-payments.server) --------------------------------- */

interface DealerRow {
  planId: string; dealerId: string; dealerName: string; schemeId: string; schemeName: string;
  salesOfficerId: string; salesOfficerName: string; state: string | null;
  paymentCount: number; totalPaid: number; lastReceivedDate: string | null; lastRecordedAt: string | null;
}
interface DealerList { rows: DealerRow[]; filters: { states: string[]; officers: { id: string; name: string }[] } }
interface TInstallment { installmentId: string; instanceNumber: number; installmentNumber: number; plannedAmount: number; receivedAmount: number; status: string; receivedPct: number }
interface TAllocation { instanceNumber: number; installmentNumber: number; allocated: number; cumulative: number; plannedAmount: number; resultingStatus: string; receivedPct: number }
interface TPayment { id: string; amount: number; receivedDate: string; recordedAt: string; createdByName: string | null; note: string | null; allocations: TAllocation[] }
interface Timeline {
  plan: { planId: string; dealerId: string; dealerName: string; schemeId: string; schemeName: string; salesOfficerName: string; state: string | null };
  installments: TInstallment[];
  payments: TPayment[];
  totals: { planned: number; received: number; outstanding: number };
}

const ordinal = (n: number) => { const s = ["th", "st", "nd", "rd"]; const v = n % 100; return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]); };
const dateTime = (s: string) => new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

function AllocStatusBadge({ status, pct }: { status: string; pct: number }) {
  if (status === "RECEIVED") return <Badge variant="success">Settled</Badge>;
  if (status === "PARTIAL") return <Badge variant="default">Partial · {pct.toFixed(2)}%</Badge>;
  return <Badge variant="secondary">Pending</Badge>;
}

/**
 * Payment Management page (Super Admin). Lists enrolled dealer-plans (with State / Sales Officer / received /
 * recorded date filters), defaults to the plan whose payment was MOST RECENTLY RECORDED, and shows that
 * dealer's complete, transaction-based payment timeline with per-installment allocation history. All data is
 * server-scoped; this page never recomputes money — it renders what the service returns.
 */
export function SchemePaymentsPage() {
  const [state, setState] = useState("");
  const [officerId, setOfficerId] = useState("");
  const [receivedFrom, setReceivedFrom] = useState("");
  const [receivedTo, setReceivedTo] = useState("");
  const [recordedFrom, setRecordedFrom] = useState("");
  const [recordedTo, setRecordedTo] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (state) p.set("state", state);
    if (officerId) p.set("officerId", officerId);
    if (receivedFrom) p.set("receivedFrom", receivedFrom);
    if (receivedTo) p.set("receivedTo", receivedTo);
    if (recordedFrom) p.set("recordedFrom", recordedFrom);
    if (recordedTo) p.set("recordedTo", recordedTo);
    return p.toString();
  }, [state, officerId, receivedFrom, receivedTo, recordedFrom, recordedTo]);

  const { data, isLoading } = useQuery<DealerList>({ queryKey: ["payment-dealers", qs], queryFn: () => api.get(`/api/scheme-payments/dealers${qs ? `?${qs}` : ""}`) });

  // Default selection = the most-recently-recorded dealer (rows are already sorted that way server-side).
  // Keep the selection valid whenever the filtered list changes.
  useEffect(() => {
    const rows = data?.rows ?? [];
    if (rows.length === 0) { setSelected(null); return; }
    if (!selected || !rows.some((r) => r.planId === selected)) setSelected(rows[0].planId);
  }, [data, selected]);

  // Date filters also narrow the shown payments in the timeline.
  const timelineQs = useMemo(() => {
    const p = new URLSearchParams();
    if (receivedFrom) p.set("receivedFrom", receivedFrom);
    if (receivedTo) p.set("receivedTo", receivedTo);
    if (recordedFrom) p.set("recordedFrom", recordedFrom);
    if (recordedTo) p.set("recordedTo", recordedTo);
    return p.toString();
  }, [receivedFrom, receivedTo, recordedFrom, recordedTo]);
  const timeline = useQuery<Timeline>({
    queryKey: ["payment-timeline", selected, timelineQs],
    queryFn: () => api.get(`/api/scheme-payments/dealers/${selected}${timelineQs ? `?${timelineQs}` : ""}`),
    enabled: !!selected,
  });

  const rows = data?.rows ?? [];
  const officers = data?.filters.officers ?? [];
  const states = data?.filters.states ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Payments" }]}
        title="Payments"
        subtitle="Record and review payments received on enrolled schemes. Payments are the source of truth for money received."
      />

      {/* Filters */}
      <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label>State</Label>
          <NativeSelect value={state} onChange={(e) => setState(e.target.value)} options={[{ value: "", label: "All states" }, ...states.map((s) => ({ value: s, label: s }))]} />
        </div>
        <div className="space-y-1.5">
          <Label>Sales Officer</Label>
          <NativeSelect value={officerId} onChange={(e) => setOfficerId(e.target.value)} options={[{ value: "", label: "All Sales Officers" }, ...officers.map((o) => ({ value: o.id, label: o.name }))]} />
        </div>
        <div className="space-y-1.5">
          <Label>Payment Received Date</Label>
          <div className="flex items-center gap-2">
            <Input type="date" value={receivedFrom} onChange={(e) => setReceivedFrom(e.target.value)} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={receivedTo} onChange={(e) => setReceivedTo(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5 md:col-start-3">
          <Label>Payment Recorded Date</Label>
          <div className="flex items-center gap-2">
            <Input type="date" value={recordedFrom} onChange={(e) => setRecordedFrom(e.target.value)} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={recordedTo} onChange={(e) => setRecordedTo(e.target.value)} />
          </div>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-background py-16 text-center">
          <IndianRupee className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium">No payments found</p>
          <p className="text-sm text-muted-foreground">No enrolled dealer matches these filters, or no payments have been recorded yet. Record one from Scheme Planning → Enrolled Scheme → Add Payment.</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          {/* Dealer list */}
          <div className="overflow-hidden rounded-lg border bg-background">
            <div className="border-b bg-muted/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dealers</div>
            <div className="max-h-[70vh] overflow-auto">
              {rows.map((r) => (
                <button
                  key={r.planId}
                  type="button"
                  onClick={() => setSelected(r.planId)}
                  className={cn("flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left text-sm hover:bg-muted/40", selected === r.planId && "bg-primary/10")}
                >
                  <span className="font-medium">{r.dealerName}</span>
                  <span className="text-xs text-muted-foreground">{r.schemeName} · {r.salesOfficerName}{r.state ? ` · ${r.state}` : ""}</span>
                  <span className="text-xs text-muted-foreground">{r.paymentCount} payment{r.paymentCount === 1 ? "" : "s"} · {formatCurrency(r.totalPaid)}{r.lastRecordedAt ? ` · recorded ${formatDate(r.lastRecordedAt)}` : ""}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Timeline */}
          <div className="space-y-4">
            {!selected || timeline.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : timeline.data ? (
              <DealerTimeline t={timeline.data} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function DealerTimeline({ t }: { t: Timeline }) {
  const multi = new Set(t.installments.map((i) => i.instanceNumber)).size > 1;
  const instLabel = (instanceNumber: number, installmentNumber: number) => `${multi ? `S${instanceNumber} · ` : ""}${ordinal(installmentNumber)} Installment`;
  return (
    <>
      <div className="rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t.plan.dealerName}</h2>
            <p className="text-sm text-muted-foreground">{t.plan.schemeName} · {t.plan.salesOfficerName}{t.plan.state ? ` · ${t.plan.state}` : ""}</p>
          </div>
          <div className="flex gap-4 text-sm">
            <div><div className="text-xs text-muted-foreground">Planned</div><div className="font-semibold tabular-nums">{formatCurrency(t.totals.planned)}</div></div>
            <div><div className="text-xs text-muted-foreground">Received</div><div className="font-semibold tabular-nums text-success">{formatCurrency(t.totals.received)}</div></div>
            <div><div className="text-xs text-muted-foreground">Outstanding</div><div className={cn("font-semibold tabular-nums", t.totals.outstanding > 0 && "text-destructive")}>{formatCurrency(t.totals.outstanding)}</div></div>
          </div>
        </div>
        {/* Current installment rollup */}
        <div className="mt-3 flex flex-wrap gap-2">
          {t.installments.map((i) => (
            <div key={i.installmentId} className="rounded-md border px-2 py-1 text-xs">
              <span className="font-medium">{instLabel(i.instanceNumber, i.installmentNumber)}</span>{" "}
              <span className="text-muted-foreground">{formatCurrency(i.receivedAmount)} / {formatCurrency(i.plannedAmount)}</span>{" "}
              <AllocStatusBadge status={i.status} pct={i.receivedPct} />
            </div>
          ))}
        </div>
      </div>

      {t.payments.length === 0 ? (
        <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">No payments in the selected date range.</div>
      ) : (
        t.payments.map((p, idx) => (
          <div key={p.id} className="rounded-lg border bg-background p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-base font-semibold">Payment #{t.payments.length - idx} · {formatCurrency(p.amount)}</div>
              <div className="text-xs text-muted-foreground">Received {formatDate(p.receivedDate)} · Recorded {dateTime(p.recordedAt)}{p.createdByName ? ` · by ${p.createdByName}` : ""}</div>
            </div>
            {p.note && <p className="mt-1 text-xs italic text-muted-foreground">{p.note}</p>}
            <div className="mt-2 space-y-1">
              {p.allocations.map((a, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-[10rem]">{instLabel(a.instanceNumber, a.installmentNumber)}</span>
                  <span className="tabular-nums">→ {formatCurrency(a.allocated)}</span>
                  <span className="text-xs text-muted-foreground">cumulative {formatCurrency(a.cumulative)} / {formatCurrency(a.plannedAmount)}</span>
                  <AllocStatusBadge status={a.resultingStatus} pct={a.receivedPct} />
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}
