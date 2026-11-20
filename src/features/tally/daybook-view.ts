import type { DaybookDealerRow, DaybookExcludedVoucher } from "./daybook-result-types";
import type { DaybookCredit } from "./daybook-preview";
import type { DaybookBillHeader, DaybookBillHeaders } from "./daybook-bill-amounts";
import { sumDisplayAmounts } from "./daybook-bill-amounts";
export type VoucherGroup = "Sales" | "Receipts" | "Returns & credit notes" | "Other";
export const voucherGroupOrder: VoucherGroup[] = [
  "Sales",
  "Receipts",
  "Returns & credit notes",
  "Other",
];
export function voucherGroup(
  voucher: DaybookExcludedVoucher,
  header?: DaybookBillHeader,
): VoucherGroup {
  if (["cancelled", "optional"].includes(voucher.reason)) return "Other";
  if (header && !header.active) return "Other";
  if (header?.family === "Sales") return "Sales";
  if (header?.family === "Credit Note") return "Returns & credit notes";
  const type = voucher.voucherType.toUpperCase();
  if (type === "RECEIPT") return "Receipts";
  if (/SALES RETURN|CREDIT NOTE/.test(type)) return "Returns & credit notes";
  if (/SALE/.test(type) && !/ORDER/.test(type)) return "Sales";
  return "Other";
}
export function creditVoucher(row: DaybookCredit): DaybookExcludedVoucher {
  return { ...row, amount: row.creditAmount, reason: "included" };
}
export function groupVouchers(
  vouchers: DaybookExcludedVoucher[],
  headers: DaybookBillHeaders = {},
) {
  const unique = [
    ...new Map(vouchers.map((voucher) => [voucher.guid.toLowerCase(), voucher])).values(),
  ];
  return voucherGroupOrder
    .map((label) => ({
      label,
      vouchers: unique
        .filter((voucher) => voucherGroup(voucher, headers[voucher.guid.toLowerCase()]) === label)
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            a.voucherNumber.localeCompare(b.voucherNumber) ||
            a.guid.localeCompare(b.guid),
        ),
    }))
    .filter((group) => group.vouchers.length);
}
export type DealerView = {
  key: string;
  name: string;
  row?: DaybookDealerRow;
  vouchers: DaybookExcludedVoucher[];
};
export function dealerDisplayAmounts(dealer: DealerView, headers: DaybookBillHeaders = {}) {
  return groupVouchers(dealer.vouchers, headers).flatMap((group) => {
    const productAmount = ["Sales", "Returns & credit notes"].includes(group.label);
    const vouchers = group.vouchers.filter(
      (voucher) =>
        !["cancelled", "optional"].includes(voucher.reason) &&
        headers[voucher.guid.toLowerCase()]?.active !== false,
    );
    if (!vouchers.length) return [];
    return [
      {
        label: group.label + (productAmount ? " (excl. GST)" : ""),
        amount: sumDisplayAmounts(
          vouchers.map((voucher) =>
            productAmount
              ? (headers[voucher.guid.toLowerCase()]?.subtotal ?? null)
              : (voucher.amount ?? null),
          ),
        ),
      },
    ];
  });
}
export function isWebsiteDealer(dealer: DealerView) {
  if (dealer.row)
    return (
      !dealer.row.key.startsWith("ledger:") &&
      !dealer.row.key.startsWith("voucher:") &&
      ["Matched", "Prior figures kept", "Review only"].includes(dealer.row.status)
    );
  // Cancelled/optional-only parties have no totals row. The server sets dealerName
  // only after resolving the original Tally ledger to a unique website dealer.
  return dealer.vouchers.some((voucher) => voucher.dealerName === dealer.name);
}
export function dealerViews(rows: DaybookDealerRow[], excluded: DaybookExcludedVoucher[]) {
  const dealers: DealerView[] = rows
    .filter((row) => !row.key.startsWith("voucher:"))
    .map((row) => ({
      key: row.key,
      name: row.dealerName,
      row,
      vouchers: (row.creditVouchers ?? []).map(creditVoucher),
    }));
  const unassigned: DaybookExcludedVoucher[] = [];
  for (const voucher of excluded) {
    let matches = voucher.dealerName
      ? dealers.filter((dealer) => dealer.name === voucher.dealerName)
      : [];
    if (!matches.length && voucher.ledgerName)
      matches = dealers.filter(
        (dealer) =>
          dealer.row?.ledgers.includes(voucher.ledgerName!) || dealer.name === voucher.ledgerName,
      );
    if (matches.length === 1) matches[0].vouchers.push(voucher);
    else if (matches.length > 1 || (!voucher.dealerName && !voucher.ledgerName))
      unassigned.push(voucher);
    else {
      const name = voucher.dealerName ?? voucher.ledgerName!;
      const dealer = { key: "party:" + name, name, vouchers: [voucher] };
      dealers.push(dealer);
    }
  }
  for (const dealer of dealers)
    dealer.vouchers = [
      ...new Map(dealer.vouchers.map((voucher) => [voucher.guid.toLowerCase(), voucher])).values(),
    ];
  return {
    dealers: dealers.sort((a, b) => a.name.localeCompare(b.name)),
    unassigned: [
      ...new Map(unassigned.map((voucher) => [voucher.guid.toLowerCase(), voucher])).values(),
    ],
  };
}
export function matchesDealerSearch(dealer: DealerView, search: string) {
  const query = search.trim().toLocaleLowerCase();
  return (
    !query ||
    [
      dealer.name,
      ...(dealer.row?.ledgers ?? []),
      ...dealer.vouchers.flatMap((voucher) => [
        voucher.voucherNumber,
        voucher.voucherType,
        ...(voucher.billAllocations?.entries.map((entry) => entry.billReference ?? "") ?? []),
      ]),
    ].some((text) => text.toLocaleLowerCase().includes(query))
  );
}
export function shortVoucherLabel(voucher: DaybookExcludedVoucher, header?: DaybookBillHeader) {
  const group = voucherGroup(voucher, header),
    type = voucher.voucherType.toUpperCase();
  const label =
    group === "Sales"
      ? "Bill"
      : group === "Receipts"
        ? "Receipt"
        : /SALES RETURN/.test(type)
          ? "Return"
          : /CREDIT NOTE/.test(type)
            ? "Credit note"
            : voucher.voucherType;
  return `${label} ${voucher.voucherNumber || "(unnumbered)"}`;
}
