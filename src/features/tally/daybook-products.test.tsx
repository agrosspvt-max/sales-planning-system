import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "../dealer-tags/test-loader";
import { daybookProductCapture, validateProductEvidence } from "./daybook-products";
import type { DaybookSalesComparison } from "./daybook-sales-comparison";
const prefix = "cb293b57-f31b-464e-b2e1-42d4edb59b7d";
const bill = {
  guid: prefix + "-00000001",
  masterId: "1",
  alterId: "2",
  billDate: "2026-10-02",
  billNumber: "PRINTED",
  typeName: "Custom Sales",
  family: "Sales" as const,
  partyName: "Dealer",
  cancelled: false,
  optional: false,
  references: ["BILL-REF"],
  ledgerEntries: [],
  items: [
    {
      lineNo: 0,
      stockItemName: "Pack <one>",
      quantity: "1.500000",
      amount: "15.00",
      unit: "Kg",
      actualQty: "1.5 Kg",
      billedQty: "1.5 Kg",
      rate: "10/Kg",
    },
  ],
};
const evidence = {
  version: "daybook.products.v1" as const,
  status: "complete" as const,
  voucherTypes: [
    { typeName: "Custom Sales", family: "Sales" as const },
    { typeName: "Credit Note", family: "Credit Note" as const },
  ],
  vouchers: [bill],
};
const sources = [
  {
    guid: bill.guid,
    date: bill.billDate,
    voucherType: bill.typeName,
    voucherNumber: bill.billNumber,
    excluded: "unsupported_type",
  },
];
validateProductEvidence(daybookProductCapture.parse(evidence), sources, prefix);
assert.throws(
  () => validateProductEvidence({ ...evidence, vouchers: [] }, sources, prefix),
  /incomplete/,
);
assert.throws(
  () =>
    validateProductEvidence(
      { ...evidence, vouchers: [{ ...bill, billDate: "2026-10-03" }] },
      sources,
      prefix,
    ),
  /does not match/,
);
assert.throws(
  () => validateProductEvidence({ ...evidence, voucherTypes: [] }, sources, prefix),
  /families/,
);
assert.throws(
  () => validateProductEvidence({ ...evidence, vouchers: [bill, bill] }, sources, prefix),
  /does not match/,
);
assert.throws(
  () =>
    validateProductEvidence(
      { ...evidence, vouchers: [{ ...bill, items: [bill.items[0], bill.items[0]] }] },
      sources,
      prefix,
    ),
  /line/,
);
assert.throws(
  () =>
    validateProductEvidence(
      {
        ...evidence,
        vouchers: [{ ...bill, items: [{ ...bill.items[0], quantity: "-1.500000" }] }],
      },
      sources,
      prefix,
    ),
  /line/,
);
validateProductEvidence(
  { version: evidence.version, status: "unavailable", error: "DAYBOOK_PRODUCTS_SIZE_LIMIT" },
  sources,
  prefix,
);
const credit = {
  ...bill,
  typeName: "Credit Note",
  family: "Credit Note" as const,
  items: [
    {
      ...bill.items[0],
      quantity: "0.000000",
      amount: "-15.00",
      unit: "",
      actualQty: "",
      billedQty: "",
    },
  ],
};
validateProductEvidence(
  { ...evidence, vouchers: [credit] },
  [{ ...sources[0], voucherType: "Credit Note", excluded: undefined, creditAmount: "15.00" }],
  prefix,
);
const stub = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
const load = testLoader({
  "@/lib/api-client": { api: {} },
  "@/components/ui/button": { Button: stub },
  "lucide-react": { Info: stub },
  "@/components/ui/dialog": {
    Dialog: stub,
    DialogContent: stub,
    DialogDescription: stub,
    DialogHeader: stub,
    DialogTitle: stub,
    DialogTrigger: stub,
  },
});
const { DaybookComparisonResult } = load<typeof import("./daybook-sales-comparison-dialog")>(
  "src/features/tally/daybook-sales-comparison-dialog.tsx",
);
const result: DaybookSalesComparison = {
  status: "different",
  message: "Saved records differ",
  fromDate: "2026-10-01",
  throughDate: "2026-10-31",
  counts: {
    daybookBills: 1,
    salesBills: 1,
    matchedBills: 0,
    differentBills: 1,
    onlyDaybook: 0,
    onlySales: 0,
  },
  differenceCount: 1,
  differences: [
    {
      guid: bill.guid,
      reason: "Product details differ",
      daybook: {
        number: bill.billNumber,
        date: bill.billDate,
        party: bill.partyName,
        type: bill.typeName,
        cancelled: false,
        optional: false,
        items: [
          {
            productName: bill.items[0].stockItemName,
            quantity: "1.500000",
            unit: "Kg",
            amount: "15.00",
            actualQty: "1.5 Kg",
            billedQty: "1.5 Kg",
            rate: "10/Kg",
          },
        ],
      },
    },
  ],
};
const html = renderToStaticMarkup(<DaybookComparisonResult result={result} />);
for (const text of [
  "Saved records differ",
  "Daybook bills",
  "Different bills",
  "Pack &lt;one&gt;",
  "1.500000",
  "15.00",
  "10/Kg",
  "Sales: Bill not present",
  "Territory Plan continues",
  "does not replace or update",
])
  assert.ok(html.includes(text), text);
assert.doesNotMatch(html, /Pack <one>/);
const unavailable = renderToStaticMarkup(
  <DaybookComparisonResult
    result={{
      status: "unavailable",
      message: "Install connector and refresh",
      fromDate: result.fromDate,
      throughDate: result.throughDate,
    }}
  />,
);
assert.match(unavailable, /Install connector and refresh/);
assert.doesNotMatch(unavailable, /Matching bills/);
console.log(
  "Daybook product evidence completeness/source/sign validation and comparison result rendering: PASS",
);
