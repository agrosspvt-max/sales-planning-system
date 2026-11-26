import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "../dealer-tags/test-loader";
import { dealerSalesBreakdown, sameSalesMeasure, sumSalesMeasures } from "./dealer-sales-breakdown";
import type { DealerSalesBill } from "./dealer-sales-bills";
import type { TerritoryDealerSummary } from "./group-dealer-summary";

const bill = (
  id: string,
  family: string,
  type: string,
  productId: string,
  quantity: number,
  amount: number,
): DealerSalesBill => ({
  id,
  guid: id,
  date: "2026-06-01",
  number: id,
  type,
  family,
  cancelled: false,
  optional: false,
  items: [{ lineNo: 0, productName: productId, productId, quantity, amount, unit: "Kg" }],
});
const bills = [
  bill("S1", "Sales", "CASH SALE", "Product <one>", 10, 1000),
  bill("R1", "Credit Note", "SALES RETURN-CG", "Product <one>", -2, -200),
  bill("C1", "Credit Note", "CREDIT NOTE", "Product <one>", 0, -50),
  bill("C2", "Credit Note", "CREDIT NOTE", "Credit only", 0, -927),
  bill("R2", "Credit Note", "SALE RETURN-MP", "Return only", -1, -75),
  bill("S2", "Sales", "Credit Sale", "Fully adjusted", 1, 100),
  bill("R3", "Credit Note", "SALESRETURN", "Fully adjusted", -1, -100),
  { ...bill("X1", "Credit Note", "SALES RETURN", "Product <one>", -99, -999), cancelled: true },
  { ...bill("X2", "Sales", "Sales", "Product <one>", 99, 999), optional: true },
  { ...bill("C3", "Credit Note", "Credit Note", "", 0, 0), items: [], unallocatedAmount: -123 },
];
const expected = [
  { productId: "Product <one>", productName: "Product <one>", actualQty: 8, actualAmount: 750 },
  { productId: "Credit only", productName: "Credit only", actualQty: 0, actualAmount: -927 },
  { productId: "Return only", productName: "Return only", actualQty: -1, actualAmount: -75 },
];
const original = JSON.stringify({ bills, expected });
const split = dealerSalesBreakdown(bills, expected);
const product = split.find((row) => row.productId === "Product <one>")!;
assert.deepEqual(product.sales, { quantity: 10, amount: 1000, units: [{ unit: "kg", quantity: 10 }] });
assert.deepEqual(product.returns, { quantity: -2, amount: -200, units: [{ unit: "kg", quantity: -2 }] });
assert.deepEqual(product.creditNotes, { quantity: 0, amount: -50 });
assert.deepEqual(product.net, { quantity: 8, amount: 750, units: [{ unit: "kg", quantity: 8 }] });
assert.equal(product.reconciled, true);
assert.ok(split.every((row) => row.reconciled));
assert.equal(split.find((row) => row.productId === "Fully adjusted")!.net.amount, 0);
assert.ok(dealerSalesBreakdown(bills, expected, ["2026-06"]).every((row) => !row.reconciled));
assert.ok(
  dealerSalesBreakdown(bills, expected, [], false).every((row) => !row.reconciled),
  "mixed uploaded history cannot be declared complete merely because its net happens to match",
);
assert.equal(
  dealerSalesBreakdown([], [expected[0]])[0].reconciled,
  false,
  "no bill history must not become invented gross sales",
);
assert.equal(
  dealerSalesBreakdown(bills, [{ ...expected[0], actualAmount: 751 }]).find(
    (row) => row.productId === "Product <one>",
  )!.reconciled,
  false,
);
assert.equal(
  sumSalesMeasures([
    { quantity: 0.1, amount: 0.1 },
    { quantity: 0.2, amount: 0.2 },
  ]).amount,
  0.3,
);
assert.ok(
  sameSalesMeasure({ quantity: 0.3, amount: 0.3 }, { quantity: 0.1 + 0.2, amount: 0.1 + 0.2 }),
);
assert.equal(JSON.stringify({ bills, expected }), original);

const dealer: TerritoryDealerSummary = {
  dealerId: "dealer",
  name: "Dealer",
  planAmount: 0,
  planNbv: 0,
  actualAmount: -252,
  actualNbv: 105.88,
  products: expected.map((row, index) => ({
    ...row,
    dealerId: "dealer",
    name: "Dealer",
    planAmount: 0,
    planNbv: 0,
    actualNbv: [375.13, -231.75, -37.5][index],
    nbvPercent: 0,
  })),
};
const load = testLoader({});
const { DealerProductSalesTable } = load<typeof import("./dealer-product-sales-table")>(
  "src/features/planning/dealer-product-sales-table.tsx",
);
const expandedLoad = testLoader({ react: { ...React, useState: () => [true, () => {}] } });
const { DealerProductSalesTable: ExpandedDealerProductSalesTable } = expandedLoad<typeof import("./dealer-product-sales-table")>("src/features/planning/dealer-product-sales-table.tsx");
const render = (changes: Partial<React.ComponentProps<typeof DealerProductSalesTable>> = {}, expanded = false) => {
  const Component = expanded ? ExpandedDealerProductSalesTable : DealerProductSalesTable;
  return renderToStaticMarkup(
    <Component
      dealer={dealer}
      data={{ bills, heldMonths: [], productBreakdown: split, breakdownAvailable: true }}
      pending={false}
      error={false}
      retry={() => {}}
      categoryFiltered={false}
      {...changes}
    />,
  );
};
const dealerBeforeRender = JSON.stringify(dealer);
const html = render();
const headings = [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((match) => match[1]);
assert.deepEqual(headings, ["Product", "Sales", "Returns", "Credit notes", "Adjusted Sales", "NBV Sales"]);
assert.ok(html.includes("₹375.13") && html.includes("-₹231.75") && html.includes("-₹37.50"));
assert.ok(html.includes('aria-label="Show original totals" aria-expanded="false"'));
assert.equal(html.match(/<tfoot><tr\b[^>]*>(.*?)<\/tr>/)![1].includes("₹"), false);
const expandedHtml = render({}, true);
assert.ok(expandedHtml.includes('aria-label="Hide original totals" aria-expanded="true"'));
assert.match(expandedHtml, /aria-label="NBV Sales Total"[^>]*>₹105\.88/);
assert.match(html, /aria-label="Net Sales Sales Total"[^>]*>₹1,100\.00/);
assert.match(html, /aria-label="Net Sales Returns Total"[^>]*>-₹375\.00/);
assert.match(html, /aria-label="Net Sales Credit Notes Total"[^>]*>-₹977\.00/);
assert.ok(html.includes('data-financial-adjustment="credit-notes"') && html.includes("border-destructive/30 bg-destructive/5 font-semibold text-destructive"));
assert.ok(html.includes('data-financial-adjustment="net-sales"') && html.includes("bg-primary/10 font-bold"));
assert.match(html, /text-destructive[^>]*>-₹231\.75/);
for (const text of [
  "Sales",
  "Returns",
  "Credit notes",
  "Adjusted Sales",
  "Net Sales",
  "Product &lt;one&gt;",
  "Credit only",
  "Return only",
  "Fully adjusted",
  "1,000",
  "-₹200",
  "-₹50",
  "₹750",
  "-₹927",
  "Credit Notes (1)",
])
  assert.ok(html.includes(text), text);
assert.ok(!html.includes("999"), "cancelled and optional movements do not leak into the split");
assert.ok(
  !render({ categoryFiltered: true }).includes("Fully adjusted"),
  "category-filtered detail cannot add a product outside that selected scope",
);
const waiting = render({ data: undefined, pending: true });
assert.ok(
  waiting.includes("Credit only") && waiting.includes("-₹927"),
  "loading never hides negative rows or changes the net total",
);
assert.ok(waiting.includes("—"));
assert.ok(waiting.includes("₹375.13"), "product NBV remains available while bill details load");
const expandedWaiting = render({ data: undefined, pending: true }, true);
assert.ok(expandedWaiting.includes("₹105.88") && expandedWaiting.includes("-₹252"), "original amount and NBV remain accessible with the totals toggle while loading");
const heldProps = {
  data: {
    bills,
    heldMonths: ["2026-06"],
    productBreakdown: dealerSalesBreakdown(bills, expected, ["2026-06"]),
  },
};
const held = render(heldProps);
assert.ok(held.includes("do not reconcile"));
assert.ok(render(heldProps, true).includes("-₹252"), "held original total remains accessible with the toggle");
assert.ok(!held.includes("₹1,000"));
assert.ok(held.includes("₹375.13"), "held bill breakdowns retain existing product NBV figures");
const empty = render({ dealer: { ...dealer, actualAmount: 0, actualNbv: 0, products: [] }, data: undefined });
assert.match(empty, /colSpan="6"|colspan="6"/);
const nbvOnly = render({
  dealer: {
    ...dealer, actualAmount: 0, actualNbv: 12.34,
    products: [{ ...dealer.products[0], productName: "NBV balance", actualAmount: 0, actualQty: 0, actualNbv: 12.34 }],
  },
  data: undefined,
});
assert.ok(nbvOnly.includes("NBV balance") && nbvOnly.includes("₹12.34"), "a non-zero existing NBV remains visible even when product net is zero");
assert.equal(JSON.stringify(dealer), dealerBeforeRender, "displaying NBV cannot change source figures");
const notice = "Are JONSON PLUS and JONSON the same product? Sales included; NBV pending.";
const pendingDealer: TerritoryDealerSummary = {
  ...dealer, actualAmount: 750, actualNbv: 0, actualNbvAvailable: false, nbvPending: true,
  products: [{ ...dealer.products[0], actualNbv: 0, nbvPending: true, reviewNotice: notice, actualUnits: [{ unit: "kg", quantity: 8 }] }],
  creditAdjustment: { notes: [], applied: true, creditAmount: 0, nbvAdjustment: null, effectiveNbvRate: null, netSales: 750, netNbv: null, nbvPending: true },
};
const pendingHtml = render({ dealer: pendingDealer });
assert.match(pendingHtml, /Are JONSON PLUS and JONSON the same product/);
assert.match(pendingHtml, /8 kg/);
assert.match(pendingHtml, /aria-label="Net Sales NBV Total"[^>]*>Pending/);
assert.match(pendingHtml, /aria-label="Net Sales Total"[^>]*>₹750/);
const { DealerBillList } = load<typeof import("./dealer-bill-list")>("src/features/planning/dealer-bill-list.tsx");
const mixedBills = [bill("K", "Sales", "Sales", "Same", 10, 100), bill("L", "Sales", "Sales", "Same", 20, 200)];
mixedBills[1].items[0].unit = "LITRE";
const mixedSplit = dealerSalesBreakdown(mixedBills, [{ productId: "Same", productName: "Same", actualQty: 0, actualAmount: 300 }])[0];
assert.equal(mixedSplit.reconciled, true);
assert.equal(mixedSplit.net.quantity, 0);
assert.deepEqual(mixedSplit.net.units, [{ unit: "kg", quantity: 10 }, { unit: "litre", quantity: 20 }]);
const mixedBillsHtml = renderToStaticMarkup(<DealerBillList bills={mixedBills} productIds={["Same"]} categoryFiltered={false} />);
assert.ok(mixedBillsHtml.includes(">Kg<") && mixedBillsHtml.includes(">LITRE<"), "bill view keeps the exact recorded units");
console.log(
  "Sales / Returns / Credit notes split: signed source movements, zero-quantity and zero-net credits, status/category/held guards, exact reconciliation, preserved original net and unavailable-history rendering: PASS",
);
