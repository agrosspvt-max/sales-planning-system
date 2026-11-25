import type { DaybookBillHeader, DaybookBillHeaders } from "./daybook-bill-amounts";
import type { DaybookExcludedVoucher } from "./daybook-result-types";
import { isWebsiteDealer, type DealerView } from "./daybook-view";

export type DaybookScope =
  | "all"
  | "dealers"
  | "credit-qty"
  | "return-no-qty"
  | "credit-product"
  | "credit-no-product";
export const daybookScopes: { value: DaybookScope; label: string; description?: string }[] = [
  { value: "all", label: "All" },
  { value: "dealers", label: "Dealers only" },
  {
    value: "credit-qty",
    label: "Credit Note with qty",
    description:
      "Credit Notes with at least one non-zero actual or billed product quantity. Sales Returns are kept separate.",
  },
  {
    value: "return-no-qty",
    label: "Sales Return W/O qty",
    description:
      "Sales Returns with no product lines or only zero/blank quantities in the saved capture. Missing quantity details are not treated as zero.",
  },
  {
    value: "credit-product",
    label: "Credit Note with product",
    description:
      "Credit Notes with at least one product line, including zero-quantity value adjustments. Sales Returns are kept separate.",
  },
  {
    value: "credit-no-product",
    label: "Credit note without product",
    description:
      "Credit Notes with a saved empty product list. Sales Returns are kept separate. Missing product details are not treated as no products.",
  },
];
function active(voucher: DaybookExcludedVoucher, header?: DaybookBillHeader) {
  return !["cancelled", "optional"].includes(voucher.reason) && header?.active !== false;
}
export function matchesDaybookScope(
  voucher: DaybookExcludedVoucher,
  scope: DaybookScope,
  header?: DaybookBillHeader,
) {
  if (!active(voucher, header) || header?.family !== "Credit Note") return false;
  if (scope === "return-no-qty")
    return header.isSalesReturn === true && header.hasQuantity === false;
  // No type/family guess when compact product evidence is missing or from an older response.
  if (header.isSalesReturn !== false) return false;
  if (scope === "credit-no-product") return header.hasProducts === false;
  return scope === "credit-qty"
    ? header.hasQuantity === true
    : scope === "credit-product" && header.hasProducts === true;
}
export function filterDaybookView(
  view: { dealers: DealerView[]; unassigned: DaybookExcludedVoucher[] },
  scope: DaybookScope,
  headers: DaybookBillHeaders,
) {
  if (scope === "all") return view;
  if (scope === "dealers") return { dealers: view.dealers.filter(isWebsiteDealer), unassigned: [] };
  const matches = (voucher: DaybookExcludedVoucher) =>
    matchesDaybookScope(voucher, scope, headers[voucher.guid.toLowerCase()]);
  return {
    dealers: view.dealers
      .map((dealer) => ({ ...dealer, vouchers: dealer.vouchers.filter(matches) }))
      .filter((dealer) => dealer.vouchers.length > 0),
    unassigned: view.unassigned.filter(matches),
  };
}
export function unclassifiedDaybookCredits(
  view: { dealers: DealerView[]; unassigned: DaybookExcludedVoucher[] },
  headers: DaybookBillHeaders,
) {
  return [
    ...new Map(
      [...view.dealers.flatMap((dealer) => dealer.vouchers), ...view.unassigned].map((voucher) => [
        voucher.guid.toLowerCase(),
        voucher,
      ]),
    ).values(),
  ].filter((voucher) => {
    const header = headers[voucher.guid.toLowerCase()];
    if (!active(voucher, header)) return false;
    if (
      header?.family !== "Credit Note" &&
      !/CREDIT[\s_-]*NOTE|SALES[\s_-]*RETURN/i.test(voucher.voucherType)
    )
      return false;
    return (
      header?.isSalesReturn === undefined ||
      header.hasProducts === undefined ||
      header.hasQuantity == null
    );
  }).length;
}
