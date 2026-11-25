import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "../dealer-tags/test-loader";
import { daybookBillHeaders } from "./daybook-bill-amounts";
import {
  filterDaybookView,
  unclassifiedDaybookCredits,
  type DaybookScope,
} from "./daybook-filters";
import { dealerViews, dealerDisplayAmounts } from "./daybook-view";
import { combineDaybookMonths } from "./daybook-range";
import type { DaybookProductVoucher } from "./daybook-products";
import type { DaybookExcludedVoucher } from "./daybook-result-types";

const item = {
  lineNo: 0,
  stockItemName: "Item A",
  quantity: "-2.000000",
  amount: "-20.00",
  unit: "Kg",
  actualQty: "2 Kg",
  billedQty: "2 Kg",
  rate: "10/Kg",
};
const bill = (guid: string, typeName = "Credit Note", items = [item]): DaybookProductVoucher => ({
  guid,
  typeName,
  family: "Credit Note",
  masterId: "1",
  alterId: "1",
  billDate: "2026-11-01",
  billNumber: guid,
  partyName: "Dealer A",
  cancelled: false,
  optional: false,
  references: [],
  ledgerEntries: [],
  items,
});
const bills = [
  bill("CN-QTY"),
  bill("CN-VALUE", "Credit Note", [
    { ...item, quantity: "0.000000", actualQty: "", billedQty: "0 Kg" },
  ]),
  bill("CN-EMPTY", "Credit Note", []),
  bill("SR-QTY", "Sales Return-CG"),
  bill("SR-ZERO", "Sales Return-CG", [
    { ...item, quantity: "0.000000", actualQty: "0 Kg", billedQty: "0 Kg" },
  ]),
  bill("SR-EMPTY", "SALES RETURN-MP", []),
  bill("CN-ACTUAL", "Credit Note", [
    { ...item, quantity: "0.000000", actualQty: ".5 Kg = 1 case", billedQty: "0 Kg" },
  ]),
  bill("SR-UNKNOWN", "Sales Return", [
    { ...item, quantity: "0.000000", actualQty: "Quantity not readable", billedQty: "0 Kg" },
  ]),
  { ...bill("CN-CANCELLED"), cancelled: true },
  { ...bill("CN-OPTIONAL"), optional: true },
  { ...bill("SALE"), family: "Sales" as const, typeName: "Sales" },
  bill("CN-CUSTOM", "Discount Adjustment"),
  bill("CN-EMPTY-CUSTOM", "Discount Adjustment", []),
  { ...bill("CN-CANCELLED-EMPTY", "Credit Note", []), cancelled: true },
  { ...bill("CN-OPTIONAL-EMPTY", "Credit Note", []), optional: true },
];
const headers = daybookBillHeaders(bills);
assert.equal(
  headers["cn-actual"].hasQuantity,
  true,
  "actual stock with no billed qty still counts",
);
assert.equal(headers["sr-unknown"].hasQuantity, null, "unreadable quantity cannot become zero");
assert.equal(headers["cn-empty"].hasProducts, false);
assert.equal(headers["cn-value"].hasProducts, true);
assert.equal(
  headers["sr-empty"].hasQuantity,
  false,
  "complete empty product list is known to have no stock qty",
);
const vouchers: DaybookExcludedVoucher[] = bills.map((record) => ({
  guid: record.guid,
  voucherNumber: record.billNumber,
  voucherType: record.typeName,
  date: record.billDate,
  ledgerName: record.partyName,
  amount: "20.00",
  reason: record.cancelled ? "cancelled" : record.optional ? "optional" : "included",
}));
vouchers.push({
  guid: "CN-MISSING",
  voucherNumber: "CN-MISSING",
  voucherType: "Credit Note",
  date: "2026-11-01",
  ledgerName: "Dealer A",
  reason: "included",
});
const rows = [
  {
    key: "dealer-a",
    dealerName: "Dealer A",
    ledgers: ["Dealer A"],
    status: "Matched",
    liveRecovery: "0.00",
    srCr: "200.00",
    other: "0.00",
  },
];
const view = dealerViews(rows, vouchers);
view.unassigned.push({
  ...vouchers[0],
  guid: "CN-UNASSIGNED",
  voucherNumber: "CN-UNASSIGNED",
  ledgerName: undefined,
});
headers["cn-unassigned"] = { ...headers["cn-qty"] };
view.unassigned.push({
  ...vouchers[2],
  guid: "CN-EMPTY-UNASSIGNED",
  voucherNumber: "CN-EMPTY-UNASSIGNED",
  ledgerName: undefined,
});
headers["cn-empty-unassigned"] = { ...headers["cn-empty"] };
const before = JSON.stringify({ view, headers });
const ids = (scope: DaybookScope) =>
  filterDaybookView(view, scope, headers).dealers.flatMap((dealer) =>
    dealer.vouchers.map((v) => v.guid),
  );
assert.deepEqual(ids("credit-qty"), ["CN-QTY", "CN-ACTUAL", "CN-CUSTOM"]);
assert.deepEqual(ids("return-no-qty"), ["SR-ZERO", "SR-EMPTY"]);
assert.deepEqual(ids("credit-product"), ["CN-QTY", "CN-VALUE", "CN-ACTUAL", "CN-CUSTOM"]);
assert.deepEqual(ids("credit-no-product"), ["CN-EMPTY", "CN-EMPTY-CUSTOM"]);
assert.equal(filterDaybookView(view, "credit-no-product", headers).unassigned.length, 1);
assert.equal(
  dealerDisplayAmounts(filterDaybookView(view, "credit-no-product", headers).dealers[0], headers)[0]
    .amount,
  null,
  "no product subtotal remains unavailable rather than becoming zero or a voucher total",
);
assert.equal(filterDaybookView(view, "credit-qty", headers).unassigned.length, 1);
assert.equal(filterDaybookView(view, "all", headers), view);
assert.equal(
  ids("dealers").length,
  vouchers.length,
  "original dealers-only scope retains every voucher",
);
assert.equal(filterDaybookView(view, "dealers", headers).unassigned.length, 0);
assert.equal(unclassifiedDaybookCredits(view, headers), 2);
assert.equal(
  dealerDisplayAmounts(filterDaybookView(view, "credit-qty", headers).dealers[0], headers)[0]
    .amount,
  "-60.00",
  "filtered totals include only matching signed product amounts",
);
assert.equal(
  JSON.stringify({ view, headers }),
  before,
  "filtering cannot change the original data or totals",
);

// The latest source in a multi-month range must supply both the amount and filter facts.
const range = combineDaybookMonths([
  {
    month: "2026-10",
    configured: true,
    job: null,
    published: {
      id: "old-source",
      completedAt: "2026-11-01T00:00:00Z",
      throughDate: "2026-10-31",
      summary: {
        coverage: "all_vouchers",
        dealerRows: rows,
        excludedVouchers: [vouchers[0], vouchers[2]],
        billHeaders: headers,
      },
    },
  },
  {
    month: "2026-11",
    configured: true,
    job: null,
    published: {
      id: "new-source",
      completedAt: "2026-11-20T00:00:00Z",
      throughDate: "2026-11-20",
      summary: {
        coverage: "all_vouchers",
        dealerRows: rows,
        excludedVouchers: [vouchers[0], vouchers[2]],
        billHeaders: {
          "cn-qty": { ...headers["cn-qty"], hasQuantity: false },
          "cn-empty": headers["cn-empty"],
        },
      },
    },
  },
]);
assert.equal(filterDaybookView(range.view, "credit-qty", range.billHeaders).dealers.length, 0);
assert.equal(
  filterDaybookView(range.view, "credit-product", range.billHeaders).dealers[0].vouchers[0]
    .sourceJobId,
  "new-source",
);
assert.equal(
  filterDaybookView(range.view, "credit-no-product", range.billHeaders).dealers[0].vouchers[0]
    .sourceJobId,
  "new-source",
);
assert.equal(
  filterDaybookView(view, "credit-no-product", {}).dealers.length,
  0,
  "missing evidence is not classified as an empty product list",
);

for (const scope of [
  "all",
  "dealers",
  "credit-qty",
  "return-no-qty",
  "credit-product",
  "credit-no-product",
] as DaybookScope[]) {
  const productSources: string[] = [];
  const load = testLoader({
    react: {
      ...React,
      useState: (initial: unknown) => [initial === "all" ? scope : initial, () => {}],
    },
    "next/link": {
      __esModule: true,
      default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    },
    "./daybook-referenced-bill-products": {
      DaybookOwnProducts: ({ source }: { source: { jobId: string } }) => {
        productSources.push(source.jobId);
        return null;
      },
    },
    "./daybook-bill-allocation-table": { DaybookBillAllocationTable: () => null },
  });
  const { DaybookResultTables } = load<typeof import("./daybook-result-tables")>(
    "src/features/tally/daybook-result-tables.tsx",
  );
  const html = renderToStaticMarkup(
    <DaybookResultTables
      dealerRows={rows}
      preparedView={view}
      sourceJobId="original-source"
      billHeaders={headers}
      coverage="all_vouchers"
    />,
  );
  for (const label of [
    "All (1)",
    "Dealers only (1)",
    "Credit Note with qty (1)",
    "Sales Return W/O qty (1)",
    "Credit Note with product (1)",
    "Credit note without product (1)",
  ])
    assert.ok(html.includes(label), label);
  if (scope === "all" || scope === "dealers") {
    assert.ok(html.includes("CN-MISSING"));
    continue;
  }
  const selected = ids(scope);
  for (const source of vouchers)
    assert.equal(
      html.includes(`No. ${source.guid}`),
      selected.includes(source.guid),
      `${scope}: ${source.guid}`,
    );
  assert.match(html, /Only matching vouchers and their totals are shown/);
  assert.match(html, /2 return\/credit-note vouchers have incomplete/);
  assert.ok(productSources.every((id) => id === "original-source"));
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:[=>\s])/);
}
console.log(
  "Daybook filters: separate Credit Notes/Sales Returns, nonzero actual/billed qty, zero/no products, unknown evidence, signed scoped totals, range source, active flags and rendered tabs passed.",
);
