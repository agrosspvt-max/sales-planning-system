import assert from "node:assert/strict";
import React from "react";
import * as XLSX from "xlsx";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dealerCreditAdjustment,
  recordedCreditAmount,
  type DealerCreditNote,
} from "./dealer-credit-adjustments";
import { summarizeTerritoryDealers } from "./group-dealer-summary";
import {
  buildGroupPlanWorkbook,
  dealerFinancialTotals,
  dealerPlanColumns,
} from "./group-plan-export";
import { testLoader } from "../dealer-tags/test-loader";
const note: DealerCreditNote = {
  id: "note",
  guid: "note",
  monthKey: "2026-06",
  date: "2026-06-01",
  number: "CN10",
  type: "Credit Note",
  amount: -10,
};
const record = { dealerId: "dealer", name: "Dealer", unavailable: false, notes: [note] };
assert.equal(recordedCreditAmount("Dealer", [{ name: "Dealer", amount: "10.00" }]), -10);
assert.equal(recordedCreditAmount("Dealer", [{ name: "Dealer", amount: "-10.00" }]), 10);
assert.equal(recordedCreditAmount("Dealer", []), null);
assert.equal(recordedCreditAmount("Dealer", [{ name: "Dealer", amount: "?" }]), null);
const net = dealerCreditAdjustment(100, 15, record);
assert.equal(net.netSales, 90);
assert.equal(net.netNbv, 13.5);
assert.equal(net.nbvAdjustment, -1.5);
assert.equal(net.effectiveNbvRate, 0.15);
assert.equal(dealerCreditAdjustment(100, 15, { ...record, notes: [note, note] }).netSales, 90);
assert.equal(
  dealerCreditAdjustment(100, 15, { ...record, notes: [{ ...note, amount: -120 }] }).netNbv,
  -3,
);
assert.equal(dealerCreditAdjustment(-100, -15, record).netNbv, -16.5);
assert.equal(dealerCreditAdjustment(100, 0, record).netNbv, 0);
assert.equal(dealerCreditAdjustment(0, 0, record).netSales, -10);
assert.equal(dealerCreditAdjustment(0, 0, record).netNbv, null);
assert.equal(dealerCreditAdjustment(0, 0, { notes: [], unavailable: false }).netNbv, 0);
assert.equal(dealerCreditAdjustment(100, 15.123456, { notes: [], unavailable: false }).netNbv, 15.123456);
assert.equal(dealerCreditAdjustment(100, 15, { ...record, unavailable: true }).netSales, null);
assert.equal(
  dealerCreditAdjustment(100, 15, { ...record, notes: [{ ...note, amount: null }] }).netNbv,
  null,
);
assert.equal(
  dealerCreditAdjustment(3, 1, { ...record, notes: [{ ...note, amount: -1 }] }).nbvAdjustment,
  -0.33,
);
assert.equal(
  dealerCreditAdjustment(3, 1, { ...record, notes: [{ ...note, amount: -1 }] }).netNbv,
  0.67,
);
const product = {
  dealerId: "dealer",
  name: "Dealer",
  productId: "p",
  productName: "Product",
  nbvPercent: 0.15,
  planAmount: 200,
  planNbv: 30,
  actualQty: 1,
  actualAmount: 100,
  actualNbv: 15,
};
const before = JSON.stringify({ product, record });
const [dealer] = summarizeTerritoryDealers([product], "", [], [record]);
assert.equal(dealer.actualAmount, 90);
assert.equal(dealer.actualNbv, 13.5);
assert.equal(dealer.salesBeforeCredits, 100);
assert.equal(dealer.products[0].actualAmount, 100);
assert.equal(dealerPlanColumns.find((c) => c.key === "salesAchievement")!.value(dealer), 0.45);
assert.equal(dealerPlanColumns.find((c) => c.key === "nbvAchievement")!.value(dealer), 0.45);
const [category] = summarizeTerritoryDealers(
  [product],
  "cat",
  [{ id: "cat", name: "Category", nbvPercent: 0.15, notation: null, color: null }],
  [record],
);
assert.equal(category.actualAmount, 100);
assert.equal(category.actualNbv, 15);
assert.equal(category.creditAdjustment!.applied, false);
assert.equal(JSON.stringify({ product, record }), before);
const [creditOnly] = summarizeTerritoryDealers([], "", [], [record]);
assert.equal(creditOnly.actualAmount, -10);
assert.equal(creditOnly.actualNbvAvailable, false);
const [unknown] = summarizeTerritoryDealers([product], "", [], [{ ...record, unavailable: true }]);
assert.equal(unknown.actualSalesAvailable, false);
assert.equal(dealerFinancialTotals([dealer, unknown]).actualSalesAvailable, false);
const workbook = (rows: (typeof dealer)[]) =>
  buildGroupPlanWorkbook(XLSX, {
    view: "dealer",
    rows,
    group: "State",
    season: "Season",
    period: "Month",
    officer: "All",
    plans: "Approved",
    category: "All",
  }).workbook;
const cells = XLSX.utils.sheet_to_json<unknown[]>(workbook([dealer]).Sheets["Territory Plan"], {
  header: 1,
});
const exported = cells.find((row) => row[0] === "Dealer" && row[1] === 200)!;
assert.equal(exported[3], 90);
assert.equal(exported[4], 13.5);
assert.equal(exported[5], 0.45);
const unknownCells = XLSX.utils.sheet_to_json<unknown[]>(
  workbook([unknown]).Sheets["Territory Plan"],
  { header: 1 },
);
assert.equal(unknownCells.find((row) => row[0] === "Dealer" && row[1] === 200)![3], "—");
for (const open of [false, true]) {
  const load = testLoader({ react: { ...React, useState: () => [open, () => {}] } });
  const { DealerCreditRows } = load<typeof import("./dealer-credit-rows")>(
    "src/features/planning/dealer-credit-rows.tsx",
  );
  const html = renderToStaticMarkup(
    <table>
      <tfoot>
        <DealerCreditRows adjustment={net} />
      </tfoot>
    </table>,
  );
  assert.ok(html.includes(`aria-expanded="${open}"`));
  assert.equal(html.includes("CN10"), open);
  assert.match(html, /aria-label="Credit Note NBV Adjustment"[^>]*>-₹1\.50/);
  assert.match(html, /aria-label="Additional Credit Notes Total"[^>]*>-₹10\.00/);
  assert.match(html, /aria-label="Net Sales NBV Total"[^>]*>₹13\.50/);
  assert.match(html, /aria-label="Net Sales Total"[^>]*>₹90\.00/);
}
console.log(
  "Dealer credit adjustments: exact net/weighted NBV, signs/rounding/zero/unknown, category guard, immutable products, achievement/export parity and collapsed details: PASS",
);
