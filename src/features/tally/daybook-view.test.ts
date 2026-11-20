import assert from "node:assert/strict";
import { dealerViews, groupVouchers, isWebsiteDealer, matchesDealerSearch } from "./daybook-view";
import type { DaybookDealerRow, DaybookExcludedVoucher } from "./daybook-result-types";
const credit = {
  guid: "receipt-1",
  date: "2026-06-05",
  voucherNumber: "R1",
  voucherType: "Receipt",
  category: "receipt" as const,
  ledgerName: "Tally alias",
  creditAmount: "25.00",
  creditSelection: "named_party" as const,
};
const row: DaybookDealerRow = {
  key: "dealer-1",
  dealerName: "Dealer one",
  ledgers: ["Tally alias"],
  liveRecovery: "25.00",
  srCr: "7.00",
  other: "50.00",
  status: "Matched",
  creditVouchers: [credit],
};
const base: DaybookExcludedVoucher = {
  guid: "sale-1",
  date: "2026-06-01",
  voucherNumber: "BILL-1",
  voucherType: "CASH SALE-UP",
  reason: "unsupported_type",
  dealerName: "Dealer one",
  ledgerName: "Tally alias",
  amount: "50.00",
};
const returnRow: DaybookExcludedVoucher = {
  ...base,
  guid: "return-1",
  voucherNumber: "RET1",
  voucherType: "SALES RETURN-UP",
  amount: "7.00",
  reason: "included",
};
const other = { ...base, guid: "journal-1", voucherNumber: "J1", voucherType: "Journal" };
const unknown = {
  ...base,
  guid: "unknown-1",
  voucherNumber: "U1",
  voucherType: "Stock Journal",
  dealerName: undefined,
  ledgerName: undefined,
};
const cancelled = {
  ...base,
  guid: "cancelled-1",
  voucherNumber: "C1",
  dealerName: "Only cancelled",
  ledgerName: "Other alias",
  reason: "cancelled",
};
const view = dealerViews([row], [base, base, returnRow, other, unknown, cancelled]);
assert.equal(
  view.dealers.length,
  2,
  "vouchers with only cancelled records still remain accessible under their dealer",
);
const dealer = view.dealers.find((item) => item.name === row.dealerName)!;
assert.equal(
  dealer.vouchers.length,
  4,
  "aliases merge into one dealer and source vouchers appear once",
);
assert.equal(view.unassigned.length, 1);
assert.equal(view.unassigned[0].guid, unknown.guid);
const groups = groupVouchers(dealer.vouchers);
assert.deepEqual(
  groups.map((group) => group.label),
  ["Sales", "Receipts", "Returns & credit notes", "Other"],
);
assert.deepEqual(
  groups.flatMap((group) => group.vouchers.map((voucher) => voucher.guid)),
  ["sale-1", "receipt-1", "return-1", "journal-1"],
);
assert.equal(
  groupVouchers(view.dealers.find((item) => item.name === "Only cancelled")!.vouchers)[0].label,
  "Other",
);
for (const query of ["dealer ONE", "Tally alias", "bill-1", "CASH SALE"])
  assert.ok(matchesDealerSearch(dealer, query), query);
assert.ok(!matchesDealerSearch(dealer, "No such bill"));
const duplicatedName = dealerViews([row, { ...row, key: "dealer-2", creditVouchers: [] }], [base]);
assert.equal(
  duplicatedName.unassigned[0].guid,
  base.guid,
  "ambiguous display associations do not duplicate a voucher across dealers",
);
assert.equal(row.liveRecovery, "25.00");
assert.equal(row.srCr, "7.00");
assert.equal(row.other, "50.00");
const scopedView = dealerViews(
  [
    row,
    {
      ...row,
      key: "dealer-sales",
      dealerName: "Sales only",
      status: "Review only",
      creditVouchers: [],
    },
    {
      ...row,
      key: "dealer-held",
      dealerName: "Held dealer",
      status: "Prior figures kept",
      creditVouchers: [],
    },
    {
      ...row,
      key: "ledger:Unknown",
      dealerName: "Unknown",
      status: "Needs dealer link",
      creditVouchers: [],
    },
    {
      ...row,
      key: "ledger:Bank",
      dealerName: "Bank",
      status: "Accounting ledger",
      creditVouchers: [],
    },
    {
      ...row,
      key: "ledger:Supplier",
      dealerName: "Supplier",
      status: "Review only",
      creditVouchers: [],
    },
  ],
  [
    base,
    { ...cancelled, guid: "confirmed-cancelled", dealerName: "Confirmed cancelled only" },
    cancelled,
    { ...cancelled, guid: "unlinked-only", dealerName: undefined, ledgerName: "Unlinked only" },
    unknown,
  ],
);
assert.deepEqual(
  scopedView.dealers.filter(isWebsiteDealer).map((entry) => entry.name),
  ["Confirmed cancelled only", "Dealer one", "Held dealer", "Only cancelled", "Sales only"],
  "confirmed sales-only/held/cancelled-only dealers remain; unlinked and accounting parties do not",
);
assert.ok(scopedView.dealers.find((entry) => entry.name === "Unlinked only"));
assert.equal(scopedView.unassigned.length, 1, "All retains unassigned evidence");
assert.equal(scopedView.dealers.find((entry) => entry.name === "Dealer one")?.vouchers.length, 2);
console.log(
  "Daybook dealer-first view: ordered transaction groups, exact alias grouping, deduplication, unassigned/cancelled retention, search and unchanged totals: PASS",
);
