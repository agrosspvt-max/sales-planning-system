import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "../dealer-tags/test-loader";
import { combineDaybookMonths } from "./daybook-range";
import { dealerDisplayAmounts } from "./daybook-view";
import type { DaybookMonthStatus, DaybookSummary } from "./daybook-status";
import type { DaybookDealerRow, DaybookExcludedVoucher } from "./daybook-result-types";

const voucher = (guid: string, month: string, type = "Sales"): DaybookExcludedVoucher => ({
  guid,
  date: month + "-02",
  voucherType: type,
  voucherNumber: guid,
  reason: "included",
  amount: "105.00",
  ledgerName: "Ledger A",
});
const row = (
  name: string,
  creditVouchers: DaybookDealerRow["creditVouchers"] = [],
): DaybookDealerRow => ({
  key: "dealer-a",
  dealerName: name,
  ledgers: ["Ledger A"],
  status: "Matched",
  liveRecovery: "0.00",
  srCr: "0.00",
  other: "105.00",
  creditVouchers,
});
const month = (
  key: string,
  summary: DaybookSummary,
  completedAt = key + "-20T10:00:00Z",
): DaybookMonthStatus => ({
  month: key,
  configured: true,
  job: { status: "SUCCEEDED", error: null, summary: null },
  published: {
    id: "job-" + key,
    completedAt,
    throughDate: key + "-28",
    summary: { coverage: "all_vouchers", ...summary },
  },
});
const apr = month("2026-04", {
  dealerRows: [row("Old dealer name")],
  excludedVouchers: [voucher("sale-a", "2026-04")],
  billHeaders: { "sale-a": { subtotal: "100.00", family: "Sales", active: true } },
});
const may = month("2026-05", {
  dealerRows: [
    {
      ...row("Current dealer name", [
        {
          guid: "receipt-a",
          date: "2026-05-03",
          voucherNumber: "RC-1",
          voucherType: "Receipt",
          ledgerName: "Ledger A",
          creditAmount: "12.25",
          category: "receipt",
          creditSelection: "named_party",
        },
      ]),
      liveRecovery: "12.25",
      srCr: "20.00",
      other: "210.00",
    },
  ],
  excludedVouchers: [
    voucher("sale-b", "2026-05"),
    voucher("return-a", "2026-05", "Sales Return"),
    { ...voucher("journal", "2026-05", "Journal"), ledgerName: undefined },
  ],
  billHeaders: {
    "sale-b": { subtotal: "200.00", family: "Sales", active: true },
    "return-a": { subtotal: "-20.00", family: "Credit Note", active: true },
  },
});
const before = JSON.stringify([apr, may]);
const combined = combineDaybookMonths([may, apr]);
assert.equal(JSON.stringify([apr, may]), before, "range must not mutate stored monthly data");
assert.equal(combined.view.dealers.length, 1, "confirmed dealer ID joins alias/name changes");
const dealer = combined.view.dealers[0];
assert.equal(dealer.name, "Current dealer name");
assert.equal(dealer.row?.other, "315.00");
assert.equal(dealer.monthlyDetails?.length, 2);
assert.equal(combined.view.unassigned.length, 1);
assert.equal(combined.voucherCount, 5);
assert.deepEqual(
  dealerDisplayAmounts(dealer, combined.billHeaders).map((entry) => entry.amount),
  ["300.00", "12.25", "-20.00"],
);
assert.equal(dealer.vouchers.find((v) => v.guid === "sale-a")?.sourceJobId, "job-2026-04");
assert.equal(dealer.vouchers.find((v) => v.guid === "receipt-a")?.sourceMonth, "2026-05");

// A moved voucher can occur in two monthly snapshots. Its latest capture owns all details.
const moved = structuredClone(may);
moved.published!.summary.excludedVouchers!.push({
  ...voucher("sale-a", "2026-05"),
  amount: "999.00",
});
const dedup = combineDaybookMonths([moved, apr]);
assert.equal(dedup.repeatedVouchers, 1);
assert.equal(dedup.voucherCount, 5);
assert.equal(dedup.view.dealers[0].vouchers.find((v) => v.guid === "sale-a")?.amount, "999.00");
assert.equal(
  dedup.view.dealers[0].vouchers.find((v) => v.guid === "sale-a")?.sourceJobId,
  "job-2026-05",
);
assert.equal(
  dedup.billHeaders["sale-a"],
  undefined,
  "never take a stale product header from an older source",
);
assert.equal(dealerDisplayAmounts(dedup.view.dealers[0], dedup.billHeaders)[0].amount, null);
assert.equal(
  JSON.stringify(dedup),
  JSON.stringify(combineDaybookMonths([apr, moved])),
  "input order cannot change the chosen latest source",
);
const unassignedMove = structuredClone(moved);
unassignedMove.published!.summary.excludedVouchers!.at(-1)!.ledgerName = undefined;
assert.equal(
  combineDaybookMonths([apr, unassignedMove]).view.unassigned.filter((v) => v.guid === "sale-a")
    .length,
  1,
);

const missing: DaybookMonthStatus = {
  month: "2026-06",
  configured: true,
  job: null,
  published: null,
};
const partial = combineDaybookMonths([apr, missing]);
assert.deepEqual(partial.missingMonths, ["2026-06"]);
assert.equal(partial.savedMonths, 1);
assert.equal(dealerDisplayAmounts(partial.view.dealers[0], partial.billHeaders)[0].amount, null);
const legacy = combineDaybookMonths([
  month("2026-04", { coverage: "legacy", dealerRows: [row("Totals only")] }),
]);
assert.equal(legacy.view.dealers[0].incompleteVouchers, true);
assert.equal(legacy.view.dealers[0].row?.other, "105.00", "original evidence remains available");

const cancelled = month("2026-05", {
  excludedVouchers: [
    {
      ...voucher("cancelled", "2026-05"),
      dealerName: "Old dealer name",
      ledgerName: undefined,
      reason: "cancelled",
    },
  ],
});
assert.equal(combineDaybookMonths([apr, cancelled]).view.dealers.length, 1);
const ambiguous = structuredClone(apr);
ambiguous.published!.summary.dealerRows!.push({
  ...row("Old dealer name"),
  key: "another-dealer",
  ledgers: ["Other ledger"],
});
assert.equal(
  combineDaybookMonths([ambiguous, cancelled]).view.dealers.length,
  3,
  "same name with multiple dealer IDs must not guess a link",
);

const productSources: string[] = [],
  allocationSources: string[] = [];
const overrides = {
  "@/lib/api-client": { api: {} },
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
  "./daybook-bill-allocation-table": {
    DaybookBillAllocationTable: ({ source }: { source?: { jobId: string } }) => {
      if (source) allocationSources.push(source.jobId);
      return null;
    },
  },
};
const load = testLoader(overrides);
const { DaybookResultTables } = load<typeof import("./daybook-result-tables")>(
  "src/features/tally/daybook-result-tables.tsx",
);
const html = renderToStaticMarkup(
  <DaybookResultTables
    dealerRows={[]}
    preparedView={combined.view}
    billHeaders={combined.billHeaders}
    coverage={combined.coverage}
  />,
);
assert.match(html, /Original monthly captures \(2\)/);
assert.match(html, /Sum of original monthly totals/);
assert.match(html, /Source month: <!-- -->2026-04|Source month: 2026-04/);
assert.match(html, /Old dealer name/);
assert.doesNotMatch(html, /<details[^>]*\sopen(?:[=>\s])/);
assert.ok(allocationSources.includes("job-2026-04") && allocationSources.includes("job-2026-05"));
assert.ok(productSources.includes("job-2026-04") && productSources.includes("job-2026-05"));
const legacyHtml = renderToStaticMarkup(
  <DaybookResultTables dealerRows={[]} preparedView={legacy.view} />,
);
assert.match(legacyHtml, /Incomplete period details/);
assert.match(legacyHtml, /Other \(bill totals\).*?—/);
assert.match(legacyHtml, /105\.00/);

const syncLoad = testLoader({
  ...overrides,
  "@/lib/api-client": { api: {} },
  "@tanstack/react-query": {
    useQuery: () => ({ data: { configured: true, months: [apr, may] }, isSuccess: true }),
    useMutation: () => ({ mutate: () => {} }),
  },
  react: {
    ...React,
    useState: (() => {
      let call = 0;
      return (initial: unknown) => [++call === 1 ? "2026-04" : initial, () => {}];
    })(),
  },
  "./daybook-sales-comparison-dialog": { DaybookSalesComparisonDialog: () => null },
  "./daybook-error-details": { DaybookErrorDetails: () => null },
});
const { TallyDaybookSync } = syncLoad<typeof import("./daybook-sync")>(
  "src/features/tally/daybook-sync.tsx",
);
const syncHtml = renderToStaticMarkup(<TallyDaybookSync currentMonth="2026-05" />);
assert.match(syncHtml, /From month/);
assert.match(syncHtml, /To month/);
assert.match(syncHtml, /Refresh selected months/);
assert.match(syncHtml, /2 of 2 months have/);
assert.match(syncHtml, /Month status and comparisons/);
console.log(
  "Daybook range: dealer union, exact totals, latest voucher identity/source, missing/legacy evidence and collapsed display passed.",
);
