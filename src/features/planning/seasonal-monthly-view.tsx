"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { cn, formatCurrency } from "@/lib/utils";
import { figuresForMode, type PlanningMode } from "@/lib/calc";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const qtyFmt = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

interface AMProduct {
  productId: string;
  productName: string;
  rate: number;
  nbvPercent: number;
  monthly: Record<string, { plan: number; sale: number }>;
}
interface AMDealer {
  dealerId: string;
  dealerName: string;
  products: AMProduct[];
}
interface ApprovedMonthly {
  monthlyMode: PlanningMode;
  months: { id: string; name: string; order: number }[];
  dealers: AMDealer[];
}

type View = "total" | "month" | "range";

interface AggRow {
  id: string;
  name: string;
  planQty: number;
  planAmount: number;
  planNbv: number;
  soldQty: number;
  soldAmount: number;
  soldNbv: number;
}

const EMPTY_MSG = "Monthly Planning has not been initiated for this month.";

/**
 * Wraps a Seasonal read-only view (Product Plan / Dealer Summary) with a View filter:
 * Seasonal Total (default, the passed-in seasonal table) · Specific Month · Month Range.
 * The month/range options aggregate APPROVED Monthly Plans only. If none exist, the empty
 * message is shown instead of a blank table.
 */
export function SeasonalMonthlyView({
  seasonPlanId,
  groupBy,
  seasonalTable,
}: {
  seasonPlanId: string;
  groupBy: "product" | "dealer";
  seasonalTable: React.ReactNode;
}) {
  const [view, setView] = useState<View>("total");
  const [monthA, setMonthA] = useState("");
  const [monthB, setMonthB] = useState("");

  const { data, isLoading } = useQuery<ApprovedMonthly>({
    queryKey: ["approved-monthly", seasonPlanId],
    queryFn: () => api.get(`/api/planning/season-plans/${seasonPlanId}/approved-monthly`),
    enabled: view !== "total",
  });

  const months = data?.months ?? [];
  const monthOpts = months.map((m) => ({ value: m.id, label: m.name }));

  // Which months feed the aggregation for the current view.
  const selectedMonthIds = useMemo(() => {
    if (view === "month") return monthA ? [monthA] : months[0] ? [months[0].id] : [];
    if (view === "range") {
      const a = months.find((m) => m.id === (monthA || months[0]?.id));
      const b = months.find((m) => m.id === (monthB || months[months.length - 1]?.id));
      if (!a || !b) return [];
      const [lo, hi] = a.order <= b.order ? [a.order, b.order] : [b.order, a.order];
      return months.filter((m) => m.order >= lo && m.order <= hi).map((m) => m.id);
    }
    return [];
  }, [view, monthA, monthB, months]);

  const rows = useMemo<AggRow[]>(() => {
    if (!data || selectedMonthIds.length === 0) return [];
    const mode = data.monthlyMode;
    const acc = new Map<string, AggRow>();
    for (const d of data.dealers) {
      for (const p of d.products) {
        const key = groupBy === "product" ? p.productId : d.dealerId;
        const name = groupBy === "product" ? p.productName : d.dealerName;
        let row = acc.get(key);
        if (!row) {
          row = { id: key, name, planQty: 0, planAmount: 0, planNbv: 0, soldQty: 0, soldAmount: 0, soldNbv: 0 };
          acc.set(key, row);
        }
        let planInput = 0;
        let saleInput = 0;
        for (const mid of selectedMonthIds) {
          const e = p.monthly[mid];
          if (e) {
            planInput += e.plan;
            saleInput += e.sale;
          }
        }
        const pf = figuresForMode(mode, planInput, p.rate, p.nbvPercent);
        const sf = figuresForMode(mode, saleInput, p.rate, p.nbvPercent);
        row.planQty += pf.totalQty ?? 0;
        row.planAmount += pf.amount ?? 0;
        row.planNbv += pf.nbv ?? 0;
        row.soldQty += sf.totalQty ?? 0;
        row.soldAmount += sf.amount ?? 0;
        row.soldNbv += sf.nbv ?? 0;
      }
    }
    return Array.from(acc.values()).sort((a, b) => b.planAmount - a.planAmount);
  }, [data, selectedMonthIds, groupBy]);

  const totals = useMemo(() => {
    return rows.reduce(
      (t, r) => ({
        planQty: t.planQty + r.planQty,
        planAmount: t.planAmount + r.planAmount,
        planNbv: t.planNbv + r.planNbv,
        soldQty: t.soldQty + r.soldQty,
        soldAmount: t.soldAmount + r.soldAmount,
        soldNbv: t.soldNbv + r.soldNbv,
      }),
      { planQty: 0, planAmount: 0, planNbv: 0, soldQty: 0, soldAmount: 0, soldNbv: 0 },
    );
  }, [rows]);

  const label = groupBy === "product" ? "Product" : "Dealer";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
          {(["total", "month", "range"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "rounded px-3 py-1.5 font-medium",
                view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "total" ? "Seasonal Total" : v === "month" ? "Specific Month" : "Month Range"}
            </button>
          ))}
        </div>
        {view === "month" && months.length > 0 && (
          <NativeSelect className="w-44" options={monthOpts} value={monthA || months[0].id} onChange={(e) => setMonthA(e.target.value)} />
        )}
        {view === "range" && months.length > 0 && (
          <div className="flex items-center gap-2">
            <NativeSelect className="w-40" options={monthOpts} value={monthA || months[0].id} onChange={(e) => setMonthA(e.target.value)} />
            <span className="text-sm text-muted-foreground">to</span>
            <NativeSelect className="w-40" options={monthOpts} value={monthB || months[months.length - 1].id} onChange={(e) => setMonthB(e.target.value)} />
          </div>
        )}
      </div>

      {view === "total" ? (
        seasonalTable
      ) : isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : months.length === 0 || rows.length === 0 ? (
        <div className="rounded-lg border bg-background p-10 text-center text-sm text-muted-foreground">{EMPTY_MSG}</div>
      ) : (
        <div className="overflow-auto rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[160px]">{label}</TableHead>
                <TableHead className="text-right">Plan Qty</TableHead>
                <TableHead className="text-right">Plan Amount</TableHead>
                <TableHead className="text-right">Planned NBV</TableHead>
                <TableHead className="text-right text-muted-foreground">Sold Qty</TableHead>
                <TableHead className="text-right text-muted-foreground">Sold Amount</TableHead>
                <TableHead className="text-right text-muted-foreground">Sold NBV</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{qtyFmt(r.planQty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.planAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.planNbv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{qtyFmt(r.soldQty)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.soldAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.soldNbv)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <tfoot>
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell>Total</TableCell>
                <TableCell className="text-right tabular-nums">{qtyFmt(totals.planQty)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(totals.planAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(totals.planNbv)}</TableCell>
                <TableCell className="text-right tabular-nums">{qtyFmt(totals.soldQty)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(totals.soldAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(totals.soldNbv)}</TableCell>
              </TableRow>
            </tfoot>
          </Table>
        </div>
      )}
    </div>
  );
}
