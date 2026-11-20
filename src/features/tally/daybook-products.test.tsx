import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "../dealer-tags/test-loader";
import { daybookProductCapture, validateProductEvidence } from "./daybook-products";
import type { DaybookSalesComparison } from "./daybook-sales-comparison";
import {
  billMismatchDetails,
  comparisonSignature,
  isIgnoredBillNumberCase,
} from "./daybook-comparison-details";
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
const cancelledDaybook = {
  ...bill,
  billNumber: "CG/RB/26-27/0217",
  partyName: "",
  cancelled: true,
  optional: true,
  items: [],
};
const cancelledSales = { ...cancelledDaybook, billNumber: "CG/RB/26-27/0215" };
const ignoredScope = {
  companyName: "Agromaxx Industry (2026-27)",
  fromDate: "2026-07-01",
  throughDate: "2026-07-31",
};
const ignoredA = {
  ...cancelledDaybook,
  guid: prefix + "-00010135",
  masterId: "65845",
  alterId: "152380",
  billDate: "2026-07-23",
  typeName: "CREDIT SALE-CG",
};
const ignoredB = { ...ignoredA, billNumber: "CG/RB/26-27/0215" };
assert.ok(isIgnoredBillNumberCase(ignoredScope, ignoredA, ignoredB));
assert.ok(isIgnoredBillNumberCase(ignoredScope, ignoredB, ignoredA));
assert.ok(
  isIgnoredBillNumberCase(ignoredScope, ignoredA, { ...ignoredB, billNumber: "CG/RB/26-27/0218" }),
  "The same cancelled identity's next number remains the one approved case",
);
for (const changed of [
  { ...ignoredB, guid: prefix + "-00010136" },
  { ...ignoredB, masterId: "65846" },
  { ...ignoredB, alterId: "152381" },
  { ...ignoredB, partyName: "Active branch" },
  { ...ignoredB, cancelled: false },
  { ...ignoredB, optional: false },
  { ...ignoredB, billDate: "2026-07-24" },
  { ...ignoredB, typeName: "Other Sales" },
  { ...ignoredB, billNumber: "OTHER-SERIES-218" },
  { ...ignoredB, items: bill.items },
  { ...ignoredB, ledgerEntries: [{ name: "Party", amount: "0.00" }] },
])
  assert.equal(
    isIgnoredBillNumberCase(ignoredScope, ignoredA, changed),
    false,
    "A different record or changed source data must remain checked",
  );
assert.equal(
  isIgnoredBillNumberCase({ ...ignoredScope, companyName: "Other Company" }, ignoredA, ignoredB),
  false,
);
assert.equal(
  isIgnoredBillNumberCase({ ...ignoredScope, throughDate: "2026-07-30" }, ignoredA, ignoredB),
  false,
);
assert.equal(
  isIgnoredBillNumberCase(ignoredScope, ignoredA, ignoredA),
  false,
  "Identical records count as matched normally",
);
const exact = billMismatchDetails(cancelledDaybook, cancelledSales);
assert.deepEqual(exact.fields, [
  { field: "Bill number", daybook: "CG/RB/26-27/0217", sales: "CG/RB/26-27/0215" },
]);
assert.equal(exact.reason, "Changed: Bill number");
assert.equal(exact.productDifferenceCount, 0);
assert.equal(
  comparisonSignature(bill),
  comparisonSignature({ ...bill, alterId: "999" }),
  "An edit version is diagnostic metadata, not a fabricated bill-data mismatch",
);
const flags = billMismatchDetails(bill, { ...bill, cancelled: true, optional: true });
assert.deepEqual(
  flags.fields.map((row) => row.field),
  ["Recorded cancelled", "Recorded optional"],
);
const quantity = billMismatchDetails(bill, {
  ...bill,
  items: [{ ...bill.items[0], quantity: "2.000000" }],
});
assert.deepEqual(quantity.products[0].fields, ["Quantity"]);
assert.equal(quantity.products[0].daybook[0].quantity, "1.500000");
assert.equal(quantity.products[0].sales[0].quantity, "2.000000");
const repeat = billMismatchDetails(
  { ...bill, items: [bill.items[0], { ...bill.items[0], lineNo: 1 }] },
  bill,
);
assert.equal(
  repeat.products[0].daybookLineCount,
  1,
  "Identical shared occurrences are cancelled out once",
);
assert.equal(repeat.products[0].salesLineCount, 0);
const sameTotals = billMismatchDetails(
  {
    ...bill,
    items: [
      { ...bill.items[0], quantity: "1.000000", amount: "10.00" },
      { ...bill.items[0], lineNo: 1, quantity: "2.000000", amount: "20.00" },
    ],
  },
  {
    ...bill,
    items: [
      { ...bill.items[0], quantity: "2.000000", amount: "10.00" },
      { ...bill.items[0], lineNo: 1, quantity: "1.000000", amount: "20.00" },
    ],
  },
);
assert.deepEqual(
  sameTotals.products[0].fields,
  ["Line combinations / repetitions"],
  "Equal field totals do not hide different original line combinations",
);
const ledgerChange = billMismatchDetails(
  { ...bill, ledgerEntries: [{ name: "Ledger", amount: "0.00" }] },
  { ...bill, ledgerEntries: [{ name: "Ledger", amount: "-10.00" }] },
);
assert.equal(ledgerChange.ledgers[0].daybook[0].amount, "0.00");
assert.equal(ledgerChange.ledgers[0].sales[0].amount, "-10.00");
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
const rich = renderToStaticMarkup(
  <DaybookComparisonResult
    result={{
      ...result,
      companyName: "Example Company",
      daybookCapturedAt: "2026-11-20T09:15:14Z",
      salesCapturedAt: "2026-11-16T12:05:26Z",
      differences: [
        {
          guid: bill.guid,
          ...exact,
          daybook: {
            ...result.differences![0].daybook!,
            guid: bill.guid,
            masterId: "62001",
            alterId: "140222",
            number: cancelledDaybook.billNumber,
            party: "",
            cancelled: true,
            optional: true,
            productTotal: null,
            partyLedgerAmount: null,
            items: [],
            narration: "<script>source narration</script>",
            rawCancelled: "Yes",
            rawOptional: "Yes",
          },
          sales: {
            ...result.differences![0].daybook!,
            guid: bill.guid,
            masterId: "62001",
            alterId: "140111",
            number: cancelledSales.billNumber,
            party: "",
            cancelled: true,
            optional: true,
            productTotal: null,
            partyLedgerAmount: null,
            items: [],
          },
          numberMatches: {
            count: 1,
            vouchers: [
              {
                source: "Sales",
                bill: {
                  ...result.differences![0].daybook!,
                  guid: prefix + "-00000099",
                  number: cancelledSales.billNumber,
                  party: "Example Branch",
                  cancelled: false,
                  optional: false,
                  productTotal: "15.00",
                  partyLedgerAmount: "-15.00",
                },
              },
            ],
          },
        },
      ],
    }}
  />,
);
for (const text of [
  "Changed: Bill number",
  "Exact bill field differences",
  "Example Branch",
  "62001",
  "140222",
  "140111",
  bill.guid,
  "Cancellation time",
  "Not captured",
  "Raw IsCancelled",
  "&lt;script&gt;source narration&lt;/script&gt;",
  "different GUID",
  "not a live Tally check",
  "not cancellation or edit times",
])
  assert.ok(rich.includes(text), text);
assert.match(rich.replace(/<[^>]+>/g, " "), /Recorded cancelled\s+No/);
assert.match(rich.replace(/<[^>]+>/g, " "), /Recorded optional\s+No/);
assert.doesNotMatch(rich, /<script>/);
const ignoredHtml = renderToStaticMarkup(
  <DaybookComparisonResult
    result={{
      ...result,
      status: "matched_with_ignored",
      message:
        "All other saved bills match. One specific cancelled-voucher number difference is ignored at your request.",
      counts: { ...result.counts!, matchedBills: 0, differentBills: 0, ignoredBills: 1 },
      differences: [],
      differenceCount: 0,
      ignoredCases: [
        {
          ...result.differences![0],
          reason: "Ignored at your request: cancelled voucher bill-number difference",
        },
      ],
    }}
  />,
);
assert.match(ignoredHtml, /Ignored cases/);
assert.match(ignoredHtml, /excluded from the mismatch count at your request/);
assert.match(ignoredHtml, /Original|original evidence/);
assert.match(ignoredHtml, /Pack &lt;one&gt;/, "Ignored cases retain their evidence");
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
