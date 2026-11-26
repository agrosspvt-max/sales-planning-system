import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as XLSX from "xlsx";
import { productCreditSummary } from "./product-credit-summary";
import {
  buildGroupPlanWorkbook,
  dealerFinancialTotals,
  getProductPlanColumns,
  productColumnTotals,
} from "./group-plan-export";
import { testLoader } from "../dealer-tags/test-loader";
const products = [
  {
    dealerId: "a",
    name: "Dealer A",
    productId: "p1",
    productName: "Product A",
    nbvPercent: 0.15,
    planAmount: 0,
    planNbv: 0,
    actualQty: 10,
    actualAmount: 100,
    actualNbv: 15,
  },
  {
    dealerId: "b",
    name: "Dealer B",
    productId: "p2",
    productName: "Product B",
    nbvPercent: 0.3,
    planAmount: 0,
    planNbv: 0,
    actualQty: 10,
    actualAmount: 100,
    actualNbv: 30,
  },
];
const credits = products.map((product, i) => ({
  dealerId: product.dealerId,
  name: product.name,
  unavailable: false,
  notes: [
    {
      id: "note" + i,
      guid: "guid" + i,
      date: "2026-06-01",
      monthKey: "2026-06",
      number: "CN" + i,
      type: "Credit Note",
      amount: i ? -20 : -10,
    },
  ],
}));
const original = JSON.stringify({ products, credits });
const summary = productCreditSummary(200, 45, products, credits, "", []);
assert.equal(summary.creditAmount, -30);
assert.equal(summary.nbvAdjustment, -6.75, "total uses 45 / 200, independent of dealer rates");
assert.equal(summary.netSales, 170);
assert.equal(summary.netNbv, 38.25);
assert.equal(dealerFinancialTotals(summary.dealers).actualNbv, summary.netNbv);
assert.equal(summary.dealers[0].actualAmount, 90);
assert.equal(summary.dealers[1].actualNbv, 24);
const category = productCreditSummary(100, 15, products, credits, "cat", [
  { id: "cat", name: "Category", nbvPercent: 0.15, color: null, notation: null },
]);
assert.equal(category.applied, false);
assert.equal(category.netSales, 100);
assert.equal(category.netNbv, 15);
const mismatch = productCreditSummary(201, 45, products, credits, "", []);
assert.equal(mismatch.netSales, null);
const unknown = productCreditSummary(
  200,
  45,
  products,
  [{ ...credits[0], unavailable: true }, credits[1]],
  "",
  [],
);
assert.equal(unknown.netSales, null);
assert.equal(unknown.netNbv, null);
const creditOnly = productCreditSummary(
  200,
  45,
  products,
  [{ ...credits[0], dealerId: "only" }],
  "",
  [],
);
assert.equal(creditOnly.netSales, 190);
assert.equal(creditOnly.netNbv, 42.75, "credit-only dealer uses the total base for the total NBV");
assert.equal(creditOnly.dealers.find((dealer) => dealer.dealerId === "only")!.actualNbvAvailable, false);
assert.equal(dealerFinancialTotals(creditOnly.dealers).actualNbv, creditOnly.netNbv);
assert.equal(dealerFinancialTotals(creditOnly.dealers).actualNbvAvailable, true);
const example = productCreditSummary(100, 15, [products[0]], [credits[0]], "", []);
assert.equal(example.netNbv, 13.5);
const noBase = productCreditSummary(0, 0, [], [credits[0]], "", []);
assert.equal(noBase.netSales, -10);
assert.equal(noBase.netNbv, null, "zero total sales still has no NBV rate");
const negativeNet = productCreditSummary(100, 15, [products[0]], [{ ...credits[0], notes: [{ ...credits[0].notes[0], amount: -120 }] }], "", []);
assert.equal(negativeNet.netNbv, -3, "do not clamp negative totals");
const zero = productCreditSummary(200, 45, products, [], "", []);
assert.equal(zero.netSales, 200);
assert.equal(zero.netNbv, 45);
assert.equal(JSON.stringify({ products, credits }), original);
const exportRows = products.map((row) => ({
  productName: row.productName,
  seasonQty: 20,
  plannedAllMonths: 10,
  remaining: -10,
  seasonSales: 10,
  pendingSales: -10,
  seasonAmount: 200,
  plannedAllMonthsAmount: 100,
  remainingAmount: -100,
  seasonSalesAmount: 100,
  pendingAmount: -100,
  total: { qty: 20, amount: 200, nbv: 30 },
  actual: { qty: 10, amount: row.actualAmount, nbv: row.actualNbv },
}));
for (const showAmounts of [false, true]) {
  const columns = getProductPlanColumns(showAmounts);
  const totals = productColumnTotals(exportRows, columns);
  for (const expanded of [false, true]) {
    const load = testLoader({ react: { ...React, useState: () => [expanded, () => {}] } });
    const { ProductCreditFooter } = load<typeof import("./product-credit-footer")>(
      "src/features/planning/product-credit-footer.tsx",
    );
    const html = renderToStaticMarkup(
      <table>
        <ProductCreditFooter
          columns={columns}
          totals={totals}
          summary={summary}
          onOpenCredits={() => {}}
        />
      </table>,
    );
    assert.ok(html.includes(`aria-expanded="${expanded}"`));
    assert.ok(html.includes('data-financial-adjustment="credit-notes"'));
    assert.ok(html.includes("bg-destructive/5") && html.includes("font-semibold"));
    assert.match(html, /aria-label="Credit Notes Amount"[^>]*>-₹30/);
    assert.match(html, /aria-label="Net Sales Amount"[^>]*>₹170/);
    assert.match(html, /aria-label="Credit Notes NBV"[^>]*>-₹6\.75/);
    assert.match(html, /aria-label="Net Sales NBV"[^>]*>₹38\.25/);
    const netRow = html.match(/<tr\b[^>]*data-financial-adjustment="net-sales"[^>]*>(.*?)<\/tr>/)![1];
    const netCells = [...netRow.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((cell) => cell[1]);
    columns.forEach((column, index) => {
      if (column.key === "actualAmount" || column.key === "actualNbv") return;
      const expected = column.format === "currency"
        ? totals[index].toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
        : totals[index].toLocaleString("en-IN", { maximumFractionDigits: 6 });
      assert.equal(netCells[index + 1], expected, `Net Sales retains the ${column.label} total`);
    });
    const firstRow = html.match(/<tr\b[^>]*>(.*?)<\/tr>/)![1];
    assert.equal(firstRow.includes("₹"), expanded, "original totals are hidden until expanded");
  }
  const { workbook } = buildGroupPlanWorkbook(XLSX, {
    view: "product",
    rows: exportRows,
    showAmounts,
    baseline: "Approved",
    group: "State",
    season: "Season",
    period: "Month",
    officer: "All",
    plans: "Approved",
    category: "All",
    creditSummary: summary,
  });
  const cells = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets["Product Plan"], { header: 1 });
  const credit = cells.find((row) => row[0] === "Credit Notes")!;
  const net = cells.find((row) => row[0] === "Net Sales")!;
  columns.forEach((column, i) => {
    assert.equal(
      credit[i + 1],
      column.key === "actualAmount" ? -30 : column.key === "actualNbv" ? -6.75 : "",
    );
    assert.equal(
      net[i + 1],
      column.key === "actualAmount" ? 170 : column.key === "actualNbv" ? 38.25 : totals[i],
    );
  });
  const sheet = workbook.Sheets["Product Plan"];
  assert.ok(sheet["!autofilter"], "footer is separate from product filters");
}
for (const selected of [null, "a"]) {
  const wrapper = ({ children }: { children: React.ReactNode }) => <section>{children}</section>;
  const load = testLoader({
    react: { ...React, useState: () => [selected, () => {}] },
    "@/components/ui/dialog": {
      Dialog: wrapper,
      DialogContent: wrapper,
      DialogHeader: wrapper,
      DialogDescription: wrapper,
      DialogTitle: wrapper,
    },
    "@/features/dealers/dealer-name-ui": {
      DealerName: ({ name }: { name: string }) => <span>{name}</span>,
    },
  });
  const { ProductCreditDrawer } = load<typeof import("./product-credit-drawer")>(
    "src/features/planning/product-credit-drawer.tsx",
  );
  const html = renderToStaticMarkup(
    <ProductCreditDrawer
      summary={summary}
      periodLabel="June · Approved · All Categories"
      onClose={() => {}}
      trigger={null}
    />,
  );
  assert.ok(html.includes("Dealer A"));
  assert.equal(
    html.includes("CN0"),
    selected !== null,
    "voucher details only appear after selecting the dealer",
  );
  assert.equal(html.includes("CN1"), false, "another dealer's bill is not shown in dealer details");
  if (selected === null) assert.ok(html.includes("Dealer B"));
  else assert.ok(html.includes("guid0") && html.includes("15%") && html.includes("All dealers"));
}
console.log(
  "Product Plan credits: total proportional NBV, credit-only dealer totals, preserved dealer calculations, category/unknown/zero guards, collapsed footer, drawer and Excel parity: PASS",
);
