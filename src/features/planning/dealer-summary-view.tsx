"use client";

import { useMemo } from "react";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { amount as calcAmount, nbv as calcNbv, achievement } from "@/lib/calc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePlanEdit } from "./plan-edit-context";
import { SeasonalMonthlyView } from "./seasonal-monthly-view";

interface DealerRow {
  dealerId: string;
  name: string;
  salesPlan: number;
  salesPlanNbv: number;
  liveMonthPlan: number;
  liveMonthNbv: number;
  actualSales: number;
  actualNbv: number;
}

/**
 * Dealer Summary — read-only "Excel Dealer Summary sheet". Auto-generated from Dealer Plan
 * and updated LIVE from the shared edit context. Sales Plan / NBV come from the live cells;
 * Live Month + Actuals from stored monthly data; achievements via the shared calc engine.
 */
export function DealerSummaryView() {
  const { detail, lineFig } = usePlanEdit();

  const rows = useMemo<DealerRow[]>(() => {
    return detail.dealers.map((d) => {
      let salesPlan = 0, salesPlanNbv = 0, liveMonthPlan = 0, liveMonthNbv = 0, actualSales = 0, actualNbv = 0;
      for (const l of d.lines) {
        const fig = lineFig(d.dealerId, l);
        salesPlan += fig.amount ?? 0;
        salesPlanNbv += fig.nbv ?? 0;
        const liveAmt = calcAmount(l.liveMonthlyQty, l.rate);
        liveMonthPlan += liveAmt;
        liveMonthNbv += calcNbv(liveAmt, l.nbvPercent);
        // Actual sales value comes from the uploaded sales (saleValue), not qty × rate.
        const aAmt = l.actualAmount;
        actualSales += aAmt;
        actualNbv += calcNbv(aAmt, l.nbvPercent);
      }
      return { dealerId: d.dealerId, name: d.dealerName, salesPlan, salesPlanNbv, liveMonthPlan, liveMonthNbv, actualSales, actualNbv };
    }).sort((a, b) => b.salesPlan - a.salesPlan);
  }, [detail, lineFig]);

  const totals = useMemo(() => {
    const t = { salesPlan: 0, salesPlanNbv: 0, liveMonthPlan: 0, liveMonthNbv: 0, actualSales: 0, actualNbv: 0 };
    for (const r of rows) {
      t.salesPlan += r.salesPlan; t.salesPlanNbv += r.salesPlanNbv;
      t.liveMonthPlan += r.liveMonthPlan; t.liveMonthNbv += r.liveMonthNbv;
      t.actualSales += r.actualSales; t.actualNbv += r.actualNbv;
    }
    return t;
  }, [rows]);

  const seasonalTable = (
    <div className="overflow-auto rounded-lg border bg-background">
      <Table stickyFirstColumn>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-[160px]">Dealer</TableHead>
            <TableHead className="text-right">Sales Plan</TableHead>
            <TableHead className="text-right">Sales Plan NBV</TableHead>
            <TableHead className="text-right text-muted-foreground">Live Month Plan</TableHead>
            <TableHead className="text-right text-muted-foreground">Live Month NBV</TableHead>
            <TableHead className="text-right text-muted-foreground">Actual Sales</TableHead>
            <TableHead className="text-right text-muted-foreground">Actual NBV</TableHead>
            <TableHead className="text-right">Sales Achv %</TableHead>
            <TableHead className="text-right">NBV Achv %</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">No dealers.</TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.dealerId}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(r.salesPlan)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(r.salesPlanNbv)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.liveMonthPlan)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.liveMonthNbv)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualSales)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualNbv)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(achievement(r.actualSales, r.salesPlan))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(achievement(r.actualNbv, r.salesPlanNbv))}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
        <tfoot>
          <TableRow className="bg-muted/40 font-semibold">
            <TableCell>Total</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.salesPlan)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.salesPlanNbv)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.liveMonthPlan)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.liveMonthNbv)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualSales)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualNbv)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatPercent(achievement(totals.actualSales, totals.salesPlan))}</TableCell>
            <TableCell className="text-right tabular-nums">{formatPercent(achievement(totals.actualNbv, totals.salesPlanNbv))}</TableCell>
          </TableRow>
        </tfoot>
      </Table>
    </div>
  );

  return <SeasonalMonthlyView seasonPlanId={detail.id} groupBy="dealer" seasonalTable={seasonalTable} />;
}
