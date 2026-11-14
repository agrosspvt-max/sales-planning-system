"use client";
import { useMemo, useState } from "react";
import { figuresForMode, nbv } from "@/lib/calc";
import { DealerFinancialSummaryTable } from "./dealer-financial-summary-table";
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
        let planInput = 0, saleAmount = 0;
        for (const mId of monthIds) {
          const c = cellFor(p.planLineId, mId);
          planInput += c.plan;
          // Actual sales = the uploaded amount (authoritative saleValue), NEVER qty × rate — identical to
          // the source the Dealer Monthly Plan reads (monthly[].saleAmount from buildMonthlyDealers).
          saleAmount += p.monthly[mId]?.saleAmount ?? 0;
        }
        const plan = figuresForMode(monthlyMode, planInput, p.rate, p.nbvPercent);
        planAmount += plan.amount ?? 0;
        planNbv += plan.nbv ?? 0;
        actualAmount += saleAmount;
        actualNbv += nbv(saleAmount, p.nbvPercent);
      }
      return { dealerId: d.dealerId, name: d.dealerName, planAmount, planNbv, actualAmount, actualNbv };
    }).sort((a, b) => b.planAmount - a.planAmount);
  }, [data, monthIds, monthlyMode, cellFor]);

  return (
    <div className="space-y-3">
      <MonthFilter months={data.months} state={filter} onChange={setFilter} />
      <DealerFinancialSummaryTable rows={rows} externalScroll />
    </div>
  );
}
