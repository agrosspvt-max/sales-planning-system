"use client";

import { useMemo, useState } from "react";
import { formatCurrency } from "@/lib/utils";
import { figuresForMode, nbv } from "@/lib/calc";
import { Badge } from "@/components/ui/badge";
import { ProductName } from "@/components/ui/product-name";
import { CategoryFilter } from "@/components/ui/category-filter";
import { useCategories } from "@/lib/use-categories";
import { matchesCategoryFilter } from "@/lib/product-category";
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

const qtyFmt = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

/** Monthly Product Plan — read-only, live from the monthly-edit context, filterable, with TOTALS. */
export function MonthlyProductPlan() {
  const { data, monthlyMode, cellFor } = useMonthlyEdit();
  const categories = useCategories();
  const [categoryFilter, setCategoryFilter] = useState("");
  const [filter, setFilter] = useState<MonthFilterState>(() => defaultMonthFilter(data.months));
  const monthIds = useMemo(() => resolveFilteredMonths(data.months, filter), [data.months, filter]);

  const rows = useMemo(() => {
    // Pass 1 — accumulate plan/sale inputs at the RAW product level (each raw product has a single
    // rate/NBV%), so figures are computed with the correct per-product rate.
    const byRaw = new Map<string, { effId: string; effName: string; name: string; rate: number; nbvPercent: number; planInput: number; saleInput: number; saleAmount: number; additional: boolean; isClearance: boolean; clearanceQty: number | null }>();
    for (const d of data.dealers) {
      for (const p of d.products) {
        let r = byRaw.get(p.productId);
        if (!r) {
          r = {
            effId: p.effectiveProductId ?? p.productId,
            effName: p.effectiveProductName ?? p.productName,
            name: p.productName,
            rate: p.rate,
            nbvPercent: p.nbvPercent,
            planInput: 0, saleInput: 0, saleAmount: 0,
            additional: false,
            isClearance: p.isClearance ?? false,
            clearanceQty: p.clearanceQty ?? null,
          };
          byRaw.set(p.productId, r);
        }
        if (p.isAdditional) r.additional = true;
        for (const mId of monthIds) {
          const c = cellFor(p.planLineId, mId);
          r.planInput += c.plan;
          r.saleInput += c.sale; // actual QUANTITY
          // Actual SALES VALUE = the uploaded amount (authoritative saleValue), NEVER qty × rate — the
          // same source the Dealer Monthly Plan uses (monthly[].saleAmount from buildMonthlyDealers).
          r.saleAmount += p.monthly[mId]?.saleAmount ?? 0;
        }
      }
    }
    // Pass 2 — Product Merge (Phase 12): fold raw products into their EFFECTIVE (survivor) identity.
    // Figures (amount/NBV) are summed from each source's own rate-based computation so the combined
    // amount equals the sum of the sources' amounts (survivor + merged-in), never a re-derivation
    // from combined quantity × a single rate. A merged source collapses into ONE survivor row.
    type Row = { productId: string; name: string; nbvPercent: number; additional: boolean; isClearance: boolean; clearanceQty: number | null; planQty: number; planAmount: number; planNbv: number; soldQty: number; actualAmount: number; actualNbv: number };
    const byEff = new Map<string, Row>();
    for (const [rawId, r] of byRaw.entries()) {
      const plan = figuresForMode(monthlyMode, r.planInput, r.rate, r.nbvPercent);
      const actual = figuresForMode(monthlyMode, r.saleInput, r.rate, r.nbvPercent); // quantity only
      const isSurvivorLine = r.effId === rawId;
      let row = byEff.get(r.effId);
      if (!row) {
        row = {
          productId: r.effId,
          name: r.effName,
          nbvPercent: r.nbvPercent,
          additional: false,
          isClearance: r.isClearance,
          clearanceQty: r.clearanceQty,
          planQty: 0, planAmount: 0, planNbv: 0, soldQty: 0, actualAmount: 0, actualNbv: 0,
        };
        byEff.set(r.effId, row);
      }
      // Survivor wins: the surviving product's display metadata takes precedence.
      if (isSurvivorLine) {
        row.name = r.effName;
        row.nbvPercent = r.nbvPercent;
        row.isClearance = r.isClearance;
        row.clearanceQty = r.clearanceQty;
      }
      row.additional = row.additional || r.additional;
      row.planQty += plan.totalQty ?? 0;
      row.planAmount += plan.amount ?? 0;
      row.planNbv += plan.nbv ?? 0;
      row.soldQty += actual.totalQty ?? 0;
      row.actualAmount += r.saleAmount;
      row.actualNbv += nbv(r.saleAmount, r.nbvPercent);
    }
    return Array.from(byEff.values()).sort((a, b) => b.planAmount - a.planAmount);
  }, [data, monthIds, monthlyMode, cellFor]);

  const totals = rows.reduce(
    (t, r) => ({
      planQty: t.planQty + r.planQty, planAmount: t.planAmount + r.planAmount, planNbv: t.planNbv + r.planNbv,
      soldQty: t.soldQty + r.soldQty, actualAmount: t.actualAmount + r.actualAmount, actualNbv: t.actualNbv + r.actualNbv,
    }),
    { planQty: 0, planAmount: 0, planNbv: 0, soldQty: 0, actualAmount: 0, actualNbv: 0 },
  );

  return (
    // Same single-scroll architecture as Dealer Monthly Plan: the workspace root is the scroll region; the
    // filters scroll off with the page and the table's own sticky header/first column pin to that scroller.
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <MonthFilter months={data.months} state={filter} onChange={setFilter} />
        <CategoryFilter categories={categories} value={categoryFilter} onChange={setCategoryFilter} />
      </div>
      <div className="w-max min-w-full rounded-lg border bg-background">
        <Table stickyFirstColumn stickyHeader externalScroll>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Planned Qty</TableHead>
              <TableHead className="text-right">Planned Amount</TableHead>
              <TableHead className="text-right">Planned NBV</TableHead>
              <TableHead className="text-right text-muted-foreground">Sold Qty</TableHead>
              <TableHead className="text-right text-muted-foreground">Actual Amount</TableHead>
              <TableHead className="text-right text-muted-foreground">Actual NBV</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.filter((r) => matchesCategoryFilter(r.nbvPercent, categoryFilter, categories)).length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Nothing planned.</TableCell></TableRow>
            ) : (
              rows.filter((r) => matchesCategoryFilter(r.nbvPercent, categoryFilter, categories)).map((r) => (
                <TableRow key={r.productId}>
                  <TableCell className="font-medium">
                    <ProductName name={r.name} nbvPercent={r.nbvPercent} categories={categories} isClearance={r.isClearance} clearanceQty={r.clearanceQty}>
                      {r.additional && <Badge variant="secondary" className="ml-2 text-[10px]">ADDITIONAL</Badge>}
                    </ProductName>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{qtyFmt(r.planQty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.planAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.planNbv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{qtyFmt(r.soldQty)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualNbv)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          <tfoot>
            <TableRow className="bg-muted/40 font-semibold">
              <TableCell>Total</TableCell>
              <TableCell className="text-right tabular-nums">{qtyFmt(totals.planQty)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(totals.planAmount)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(totals.planNbv)}</TableCell>
              <TableCell className="text-right tabular-nums">{qtyFmt(totals.soldQty)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualAmount)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualNbv)}</TableCell>
            </TableRow>
          </tfoot>
        </Table>
      </div>
    </div>
  );
}
