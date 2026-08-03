"use client";

import { useMemo } from "react";
import { formatCurrency } from "@/lib/utils";
import { amount as calcAmount, nbv as calcNbv } from "@/lib/calc";
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

const qty = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

interface ProductRow {
  productId: string;
  name: string;
  technicalName: string | null;
  packSums: Record<string, number>;
  planQty: number;
  planAmount: number;
  planNbv: number;
  actualQty: number;
  actualAmount: number;
  actualNbv: number;
}

/**
 * Product Plan — read-only "Excel Product Plan sheet". Auto-generated from Dealer Plan and
 * updated LIVE from the shared edit context (no refresh). Product-level roll-up across all
 * dealers, reusing the same mode-aware calc engine as Dealer Plan.
 */
export function ProductPlan() {
  const { detail, packMode, packColumns, cells, lineFig } = usePlanEdit();

  const rows = useMemo<ProductRow[]>(() => {
    const byProduct = new Map<string, ProductRow>();
    for (const d of detail.dealers) {
      for (const l of d.lines) {
        let row = byProduct.get(l.productId);
        if (!row) {
          row = {
            productId: l.productId,
            name: l.productName,
            technicalName: l.technicalName,
            packSums: {},
            planQty: 0,
            planAmount: 0,
            planNbv: 0,
            actualQty: 0,
            actualAmount: 0,
            actualNbv: 0,
          };
          byProduct.set(l.productId, row);
        }
        // Live planned figures from the shared cells.
        const fig = lineFig(d.dealerId, l);
        row.planQty += fig.totalQty ?? 0;
        row.planAmount += fig.amount ?? 0;
        row.planNbv += fig.nbv ?? 0;
        // Live pack quantities (pack mode only).
        if (packMode) {
          const cell = cells[`${d.dealerId}|${l.productId}`];
          if (cell) for (const pid of Object.keys(cell.packs)) row.packSums[pid] = (row.packSums[pid] ?? 0) + (cell.packs[pid] ?? 0);
        }
        // Actuals from stored monthly sales.
        const aAmt = calcAmount(l.actualQty, l.rate);
        row.actualQty += l.actualQty;
        row.actualAmount += aAmt;
        row.actualNbv += calcNbv(aAmt, l.nbvPercent);
      }
    }
    return Array.from(byProduct.values()).sort((a, b) => b.planAmount - a.planAmount);
  }, [detail, cells, packMode, lineFig]);

  const totals = useMemo(() => {
    const t = { packSums: {} as Record<string, number>, planQty: 0, planAmount: 0, planNbv: 0, actualQty: 0, actualAmount: 0, actualNbv: 0 };
    for (const r of rows) {
      t.planQty += r.planQty;
      t.planAmount += r.planAmount;
      t.planNbv += r.planNbv;
      t.actualQty += r.actualQty;
      t.actualAmount += r.actualAmount;
      t.actualNbv += r.actualNbv;
      for (const p of packColumns) t.packSums[p.id] = (t.packSums[p.id] ?? 0) + (r.packSums[p.id] ?? 0);
    }
    return t;
  }, [rows, packColumns]);

  const seasonalTable = (
    <div className="overflow-auto rounded-lg border bg-background">
      <Table stickyFirstColumn>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-[160px]">Product</TableHead>
            {packMode && packColumns.map((p) => <TableHead key={p.id} className="text-center">{p.name}</TableHead>)}
            <TableHead className="text-right">Total Qty</TableHead>
            <TableHead className="text-right">Total Amount</TableHead>
            <TableHead className="text-right">Planned NBV</TableHead>
            <TableHead className="text-right text-muted-foreground">Actual Qty</TableHead>
            <TableHead className="text-right text-muted-foreground">Actual Amount</TableHead>
            <TableHead className="text-right text-muted-foreground">Actual NBV</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={packMode ? packColumns.length + 7 : 7} className="py-8 text-center text-muted-foreground">
                Nothing planned yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.productId}>
                <TableCell className="font-medium">
                  {r.name}
                  {r.technicalName && <div className="text-xs text-muted-foreground">{r.technicalName}</div>}
                </TableCell>
                {packMode && packColumns.map((p) => <TableCell key={p.id} className="text-center tabular-nums">{qty(r.packSums[p.id] ?? 0)}</TableCell>)}
                <TableCell className="text-right tabular-nums">{qty(r.planQty)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(r.planAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(r.planNbv)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{qty(r.actualQty)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualAmount)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualNbv)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
        <tfoot>
          <TableRow className="bg-muted/40 font-semibold">
            <TableCell>Total</TableCell>
            {packMode && packColumns.map((p) => <TableCell key={p.id} className="text-center tabular-nums">{qty(totals.packSums[p.id] ?? 0)}</TableCell>)}
            <TableCell className="text-right tabular-nums">{qty(totals.planQty)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.planAmount)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.planNbv)}</TableCell>
            <TableCell className="text-right tabular-nums">{qty(totals.actualQty)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualAmount)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualNbv)}</TableCell>
          </TableRow>
        </tfoot>
      </Table>
    </div>
  );

  return <SeasonalMonthlyView seasonPlanId={detail.id} groupBy="product" seasonalTable={seasonalTable} />;
}
