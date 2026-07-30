"use client";

import { useMemo, useState } from "react";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { figuresForMode, achievement } from "@/lib/calc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useMonthlyEdit } from "./monthly-edit-context";
import { MonthFilter, defaultMonthFilter, resolveFilteredMonths, type MonthFilterState } from "./month-filter";

/** Monthly Dealer Summary — read-only, live, filterable, with TOTALS. */
export function MonthlyDealerSummary() {
  const { data, monthlyMode, cellFor } = useMonthlyEdit();
  const [filter, setFilter] = useState<MonthFilterState>(() => defaultMonthFilter(data.months));
  const monthIds = useMemo(() => resolveFilteredMonths(data.months, filter), [data.months, filter]);

  const rows = useMemo(() => {
    return data.dealers.map((d) => {
      let planAmount = 0, planNbv = 0, actualAmount = 0, actualNbv = 0;
      for (const p of d.products) {
        let planInput = 0, saleInput = 0;
        for (const mId of monthIds) {
          const c = cellFor(p.planLineId, mId);
          planInput += c.plan;
          saleInput += c.sale;
        }
        const plan = figuresForMode(monthlyMode, planInput, p.rate, p.nbvPercent);
        const actual = figuresForMode(monthlyMode, saleInput, p.rate, p.nbvPercent);
        planAmount += plan.amount ?? 0;
        planNbv += plan.nbv ?? 0;
        actualAmount += actual.amount ?? 0;
        actualNbv += actual.nbv ?? 0;
      }
      return { dealerId: d.dealerId, name: d.dealerName, planAmount, planNbv, actualAmount, actualNbv };
    }).sort((a, b) => b.planAmount - a.planAmount);
  }, [data, monthIds, monthlyMode, cellFor]);

  const totals = rows.reduce(
    (t, r) => ({ planAmount: t.planAmount + r.planAmount, planNbv: t.planNbv + r.planNbv, actualAmount: t.actualAmount + r.actualAmount, actualNbv: t.actualNbv + r.actualNbv }),
    { planAmount: 0, planNbv: 0, actualAmount: 0, actualNbv: 0 },
  );

  return (
    <div className="space-y-3">
      <MonthFilter months={data.months} state={filter} onChange={setFilter} />
      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Dealer</TableHead>
              <TableHead className="text-right">Monthly Plan</TableHead>
              <TableHead className="text-right">Planned NBV</TableHead>
              <TableHead className="text-right text-muted-foreground">Actual Sales</TableHead>
              <TableHead className="text-right text-muted-foreground">Actual NBV</TableHead>
              <TableHead className="text-right">Sales Achv %</TableHead>
              <TableHead className="text-right">NBV Achv %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No dealers.</TableCell></TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.dealerId}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.planAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.planNbv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualNbv)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(achievement(r.actualAmount, r.planAmount))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(achievement(r.actualNbv, r.planNbv))}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          <tfoot>
            <TableRow className="bg-muted/40 font-semibold">
              <TableCell>Total</TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(totals.planAmount)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(totals.planNbv)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualAmount)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualNbv)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatPercent(achievement(totals.actualAmount, totals.planAmount))}</TableCell>
              <TableCell className="text-right tabular-nums">{formatPercent(achievement(totals.actualNbv, totals.planNbv))}</TableCell>
            </TableRow>
          </tfoot>
        </Table>
      </div>
    </div>
  );
}
