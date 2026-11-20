/** Render the real monthly/seasonal views with mixed zero, sale-only and negative-amount products. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import type { MonthlyData, PlanDetail } from "./types";

let expanded: string | null = null;
let category = "";
const products = ["ZULU", "NINJA", "BETA", "ALPHA", "AGORA"].map((productName, i) => ({
  planLineId: `l${i}`, productId: `p${i}`, productName, rate: 100, nbvPercent: i === 2 ? .5 : .25,
  target: i === 2 ? 5 : 0, seasonSaleQty: i === 4 ? 2 : 0, seasonSaleValue: i === 1 ? -1496 : 0,
  monthly: { nov: { plan: i === 2 ? 5 : 0, sale: i === 4 ? 2 : 0, saleAmount: i === 1 ? -1496 : i === 4 ? 200 : 0 } },
}));
const data: MonthlyData = { planId: "season", seasonName: "Rabi", canEdit: false, status: "APPROVED", monthlyMode: "PACK_SIZE",
  months: [{ id: "nov", name: "November", order: 1, status: "OPEN", editable: false }], dealers: [{ dealerId: "dealer", dealerName: "Demo Dealer", products }] };
const monthlyContext = { data, monthlyMode: "PACK_SIZE", qtyMode: true, cellFor: (line: string) => products.find((p) => p.planLineId === line)!.monthly.nov,
  monthEditable: () => false, saving: false, saveStatus: {}, adminMode: false };
const lines = products.map((p) => ({ ...p, technicalName: null, inputMode: null, inputValue: null, packs: { pack: p.target }, actualQty: p.monthly.nov.sale,
  actualAmount: p.monthly.nov.saleAmount, liveMonthlyQty: p.monthly.nov.plan, productActive: true }));
const detail = { id: "season", dealers: [{ dealerId: "dealer", lines }] } as unknown as PlanDetail;
const planContext = { detail, packMode: true, packColumns: [{ id: "pack", name: "1 litre" }], cells: Object.fromEntries(lines.map((l) => [`dealer|${l.productId}`, { packs: l.packs }])),
  lineFig: (_dealer: string, line: typeof lines[number]) => ({ totalQty: line.target, amount: line.target * line.rate, nbv: line.target * line.rate * line.nbvPercent }) };
const nothing = () => null;
const overrides: Record<string, unknown> = {
  react: { ...React, useState: (initial: unknown) => {
    const state = React.useState(initial);
    return initial === null ? [expanded, () => {}] : initial === "" ? [category, () => {}] : state;
  } },
  "@/features/planning/monthly-edit-context": { useMonthlyEdit: () => monthlyContext },
  "@/features/planning/plan-edit-context": { usePlanEdit: () => planContext },
  "@/features/planning/seasonal-monthly-view": { SeasonalMonthlyView: ({ seasonalTable }: { seasonalTable: React.ReactNode }) => <>{seasonalTable}</> },
  "@/lib/api-client": { api: {} },
  "@tanstack/react-query": { useQuery: () => ({ data: { ...data, dealers: data.dealers }, isLoading: false }), useQueryClient: () => ({}), useMutation: () => ({}) },
  "@/lib/use-categories": { useCategories: () => [ { id: "half", name: "Half", nbvPercent: .5 }, { id: "quarter", name: "Quarter", nbvPercent: .25 } ] },
  "@/features/dealers/dealer-name-ui": { useDealerMarkers: () => ({}), DealerOptionName: ({ name }: { name: string }) => <>{name}</> },
  "@/features/dealers/dealer-table-ui": { DealerOrder: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  "@/components/ui/product-name": { ProductName: ({ name }: { name: string }) => <>{name}</> },
  "@/features/labels/label-ui": { Th: () => <th />, ThPlain: ({ children }: { children: React.ReactNode }) => <th>{children}</th>, LabelSectionHeaderRow: nothing },
  "@/features/planning/admin-edit-ui": { AdminEditBar: nothing, EditPlanButton: nothing, ChangeReviewDialog: nothing },
  "@/features/planning/monthly-additional-ui": { AddDealerButton: nothing, EditDealerButton: nothing, AdditionalProductsSection: nothing },
};
for (const name of ["monthly-edit-context", "plan-edit-context", "seasonal-monthly-view", "admin-edit-ui", "monthly-additional-ui"]) {
  overrides[`./${name}`] = overrides[`@/features/planning/${name}`];
}
const load = testLoader(overrides);
const { MonthlyProductPlan } = load<typeof import("./monthly-product-plan")>("src/features/planning/monthly-product-plan.tsx");
const { MonthlyPlanner } = load<typeof import("./monthly-planner")>("src/features/planning/monthly-planner.tsx");
const { ProductPlan } = load<typeof import("./product-plan")>("src/features/planning/product-plan.tsx");
const { PlanGridMonthView } = load<typeof import("./plan-grid-month-view")>("src/features/planning/plan-grid-month-view.tsx");
const names = (html: string) => [...html.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)]
  .filter((r) => !r[1]!.includes('data-row-kind="summary"') && r[2]!.includes("<td"))
  .map((r) => r[2]!.match(/<td[^>]*>([\s\S]*?)<\/td>/)?.[1]?.replace(/<[^>]*>/g, ""))
  .filter((n) => n !== "Total" && n !== "Dealer Total");
const footer = (html: string) => html.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1];
for (const [label, element, scope] of [
  ["Monthly Product Plan", <MonthlyProductPlan key="monthly-product" />, "season|nov|"],
  ["Dealer Monthly Plan", <MonthlyPlanner key="monthly-dealer" />, "season|dealer|nov|"],
  ["Seasonal Product Plan", <ProductPlan key="seasonal-product" />, "season"],
  ["Seasonal Dealer Month View", <PlanGridMonthView key="seasonal-dealer-month" seasonPlanId="season" dealerId="dealer" monthId="nov" monthName="November" />, "season|dealer|nov"],
] as const) {
  expanded = null;
  const collapsed = renderToStaticMarkup(element);
  assert.deepEqual(names(collapsed), ["AGORA", "BETA", "NINJA"], `${label}: same visible alphabetical order, with negative amount-only rows`);
  assert(collapsed.includes("2 zero-value products") && collapsed.includes("sticky-foot"), `${label}: zero-only toggle and pinned Total`);
  expanded = scope;
  const all = renderToStaticMarkup(element);
  assert.deepEqual(names(all), ["AGORA", "BETA", "NINJA", "ALPHA", "ZULU"], `${label}: separate alphabetical zero group`);
  assert.equal(footer(all), footer(collapsed), `${label}: expanding leaves totals unchanged`);
}
expanded = null;
category = "half";
const filtered = renderToStaticMarkup(<MonthlyProductPlan />);
assert.deepEqual(names(filtered), ["BETA"], "category filter still applies before grouping");
assert(!filtered.includes("Show more"), "unrelated zero products do not leak through the category filter");
assert(!footer(filtered)!.includes("1,296"), "Total follows the selected category, including amounts");
console.log("product-table-views.test.tsx — real monthly and seasonal views passed");
