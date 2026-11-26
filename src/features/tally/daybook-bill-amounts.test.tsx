import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "../dealer-tags/test-loader";
import type { DaybookProductVoucher } from "./daybook-products";
import { daybookBillAmounts, daybookBillHeaders, sumDisplayAmounts } from "./daybook-bill-amounts";
import { dealerViews, dealerDisplayAmounts } from "./daybook-view";

const bill: DaybookProductVoucher = {
  guid: "cb293b57-f31b-464e-b2e1-42d4edb59b7d-00000001",
  masterId: "1",
  alterId: "2",
  billDate: "2026-11-13",
  billNumber: "TEST-1",
  typeName: "CREDIT SALE",
  family: "Sales",
  partyName: "Test Dealer",
  cancelled: false,
  optional: false,
  references: [],
  items: [
    {
      lineNo: 0,
      stockItemName: "Test item",
      quantity: "12.000000",
      amount: "3300.00",
      unit: "Kg",
      actualQty: "12 Kg",
      billedQty: "12 Kg",
      rate: "275/Kg",
    },
  ],
  ledgerEntries: [
    { name: "Test Dealer", amount: "-3465.00" },
    { name: "Sales", amount: "3300.00" },
    { name: "Output CGST 2.5%", amount: "82.50" },
    { name: "Output SGST 2.5%", amount: "82.50" },
  ],
};
const before = JSON.stringify(bill);
const amounts = daybookBillAmounts(bill);
assert.deepEqual(amounts, {
  subtotal: "3300.00",
  total: "3465.00",
  adjustments: "0.00",
  taxes: [
    { name: "Output CGST 2.5%", kind: "CGST", amount: "82.50" },
    { name: "Output SGST 2.5%", kind: "SGST", amount: "82.50" },
  ],
});
const igst = daybookBillAmounts({
  ...bill,
  ledgerEntries: [
    { name: "Test Dealer", amount: "-3475.01" },
    { name: "I.G.S.T. @ 5%", amount: "165.00" },
    { name: "Freight", amount: "10.00" },
    { name: "Round off", amount: "0.01" },
  ],
});
assert.equal(igst.taxes[0].kind, "IGST");
assert.equal(igst.adjustments, "10.01");
assert.equal(
  igst.total,
  "3475.01",
  "total comes from the actual party ledger, not a guessed tax rate",
);
const unclassified = daybookBillAmounts({
  ...bill,
  ledgerEntries: [
    { name: "Test Dealer", amount: "-3465.00" },
    { name: "Unclassified tax account", amount: "165.00" },
  ],
});
assert.equal(unclassified.taxes.length, 0);
assert.equal(unclassified.adjustments, "165.00", "a 5% difference alone must not become GST");
const returned = {
  ...bill,
  family: "Credit Note" as const,
  typeName: "Sales return",
  items: bill.items.map((item) => ({ ...item, quantity: "-12.000000", amount: "-3300.00" })),
  ledgerEntries: bill.ledgerEntries.map((entry) => ({
    ...entry,
    amount: entry.amount.startsWith("-") ? entry.amount.slice(1) : "-" + entry.amount,
  })),
};
assert.deepEqual(daybookBillAmounts(returned), {
  subtotal: "-3300.00",
  total: "-3465.00",
  adjustments: "0.00",
  taxes: [
    { name: "Output CGST 2.5%", kind: "CGST", amount: "-82.50" },
    { name: "Output SGST 2.5%", kind: "SGST", amount: "-82.50" },
  ],
});
assert.equal(daybookBillAmounts({ ...bill, ledgerEntries: [] }).total, null);
assert.equal(daybookBillAmounts({ ...bill, items: [] }).subtotal, null);
assert.equal(daybookBillAmounts({ ...bill, partyName: "" }).total, null);
assert.equal(
  daybookBillAmounts({ ...bill, items: [{ ...bill.items[0], amount: "0.00" }] }).subtotal,
  "0.00",
);
assert.equal(sumDisplayAmounts(["0.10", "0.20"]), "0.30");
assert.equal(sumDisplayAmounts(["1.00", null]), null);
assert.equal(JSON.stringify(bill), before, "source records remain untouched");

const row = {
  key: "dealer",
  dealerName: "Test Dealer",
  ledgers: ["Test Dealer"],
  liveRecovery: "0.00",
  srCr: "0.00",
  other: "3465.00",
  status: "Review only",
};
const voucher = {
  guid: bill.guid,
  date: bill.billDate,
  voucherNumber: bill.billNumber,
  voucherType: bill.typeName,
  reason: "unsupported_type",
  dealerName: bill.partyName,
  ledgerName: bill.partyName,
  amount: "3465.00",
};
const headers = daybookBillHeaders([bill]);
assert.deepEqual(headers[bill.guid], { subtotal: "3300.00", family: "Sales", active: true });
const view = dealerViews([row], [voucher]);
assert.deepEqual(dealerDisplayAmounts(view.dealers[0], headers), [
  { label: "Sales (excl. GST)", amount: "3300.00" },
]);
assert.equal(
  dealerDisplayAmounts(view.dealers[0], {})[0].amount,
  null,
  "missing evidence never falls back to the GST-inclusive amount",
);
assert.equal(daybookBillHeaders([{ ...bill, cancelled: true }])[bill.guid].active, false);
const inactive = dealerViews([row], [{ ...voucher, reason: "cancelled" }]).dealers[0];
assert.deepEqual(
  dealerDisplayAmounts(inactive, headers),
  [],
  "cancelled amounts do not enter active dealer totals",
);
const mixed = dealerViews(
  [row],
  [
    voucher,
    voucher,
    {
      ...voucher,
      guid: "receipt",
      voucherType: "Receipt",
      reason: "included",
      amount: "500.00",
    },
    {
      ...voucher,
      guid: "journal",
      voucherType: "Journal",
      amount: "20.00",
    },
  ],
).dealers[0];
assert.deepEqual(
  dealerDisplayAmounts(mixed, headers),
  [
    { label: "Sales (excl. GST)", amount: "3300.00" },
    { label: "Receipts", amount: "500.00" },
    { label: "Other", amount: "20.00" },
  ],
  "sales leave Other; duplicate GUIDs are counted once and payment amounts retain their full value",
);

const load = testLoader({
  "@/lib/api-client": { api: {} },
  "next/link": {
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  },
});
const { DaybookBillProductResult } = load<typeof import("./daybook-referenced-bill-products")>(
  "src/features/tally/daybook-referenced-bill-products.tsx",
);
const html = renderToStaticMarkup(
  <DaybookBillProductResult
    result={{
      status: "matched",
      source: "daybook",
      ownVoucher: true,
      bill: {
        number: bill.billNumber,
        date: bill.billDate,
        type: bill.typeName,
        partyName: bill.partyName,
        cancelled: false,
        optional: false,
        amounts,
        ledgerEntries: bill.ledgerEntries,
        items: bill.items.map((item) => ({ ...item, productName: item.stockItemName })),
      },
    }}
  />,
);
for (const text of [
  "Product amount (excl. GST)",
  "Output CGST 2.5%",
  "Output SGST 2.5%",
  "82.50",
  "3,300.00",
  "3,465.00",
  "Bill total",
  "Original bill ledger amounts",
])
  assert.ok(html.includes(text), text);
assert.doesNotMatch(html, /<dt>Other adjustments<\/dt>/);
const { DaybookResultTables } = load<typeof import("./daybook-result-tables")>(
  "src/features/tally/daybook-result-tables.tsx",
);
const rendered = renderToStaticMarkup(
  <DaybookResultTables
    dealerRows={[row]}
    excludedVouchers={[voucher]}
    billHeaders={headers}
    coverage="all_vouchers"
  />,
);
const summaries = [...rendered.matchAll(/<summary[^>]*>(.*?)<\/summary>/g)]
  .map((match) => match[1])
  .join(" ");
assert.ok(summaries.includes("3,300.00"));
assert.ok(summaries.includes("excl. GST"));
assert.ok(!summaries.includes("3,465.00"), "both dealer and bill headers use the product subtotal");
assert.ok(rendered.includes("3,465.00"), "original gross amount stays in the details");
const financialCredit = {
  ...returned,
  typeName: "CREDIT NOTE-OTHER",
  items: [],
  ledgerEntries: [
    { name: bill.partyName, amount: "60600.00" },
    { name: "Scheme discount", amount: "-51355.93" },
    { name: "CGST", amount: "-4622.03" },
    { name: "SGST", amount: "-4622.03" },
    { name: "Round off", amount: "-0.01" },
  ],
};
const creditAmounts = daybookBillAmounts(financialCredit);
assert.equal(creditAmounts.subtotal, null, "no fake product subtotal");
assert.equal(creditAmounts.amountExcludingGst, "-51355.94");
assert.equal(creditAmounts.total, "-60600.00");
const creditHeaders = daybookBillHeaders([financialCredit]);
assert.equal(creditHeaders[bill.guid].amountExcludingGst, "-51355.94");
const creditVoucher = { ...voucher, voucherType: financialCredit.typeName, amount: "60600.00" };
const creditView = dealerViews([row], [creditVoucher]);
assert.deepEqual(dealerDisplayAmounts(creditView.dealers[0], creditHeaders), [
  { label: "Returns & credit notes (excl. GST)", amount: "-51355.94" },
]);
const creditRendered = renderToStaticMarkup(<DaybookResultTables dealerRows={[row]} excludedVouchers={[creditVoucher]} billHeaders={creditHeaders} coverage="all_vouchers" />);
const creditSummaries = [...creditRendered.matchAll(/<summary[^>]*>(.*?)<\/summary>/g)].map((match) => match[1]).join(" ");
assert.ok(creditSummaries.includes("51,355.94"));
assert.equal(creditSummaries.includes("60,600.00"), false);
const creditDetails = renderToStaticMarkup(<DaybookBillProductResult result={{ status: "matched", source: "daybook", ownVoucher: true,
  bill: { number: "CN", date: bill.billDate, type: financialCredit.typeName, partyName: bill.partyName, cancelled: false, optional: false,
    amounts: creditAmounts, ledgerEntries: financialCredit.ledgerEntries, items: [] } }} />);
assert.ok(creditDetails.includes("Credit amount (excl. GST)") && creditDetails.includes("51,355.94"));
assert.ok(creditDetails.includes("60,600.00") && creditDetails.includes("4,622.03"), "original gross and tax entries remain visible");
console.log(
  "Daybook pre-tax headers, source tax ledgers, signed returns, exact decimals, unavailable evidence, breakdown rendering and preserved original totals: PASS",
);
