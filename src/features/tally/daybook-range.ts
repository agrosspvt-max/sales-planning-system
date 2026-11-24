import { dealerViews, isWebsiteDealer, type DealerView } from "./daybook-view";
import type { DaybookBillHeader, DaybookBillHeaders } from "./daybook-bill-amounts";
import { sumDisplayAmounts } from "./daybook-bill-amounts";
import type { DaybookExcludedVoucher } from "./daybook-result-types";
import { summaryDealerRows, type DaybookMonthStatus } from "./daybook-status";

/** Read-only union of the latest successful monthly captures; no posting or allocation. */
export function combineDaybookMonths(months: DaybookMonthStatus[]) {
  const missingMonths = months.filter((month) => !month.published).map((month) => month.month);
  const saved = months
    .filter((month) => month.published)
    .sort(
      (a, b) =>
        Date.parse(a.published!.completedAt) - Date.parse(b.published!.completedAt) ||
        a.month.localeCompare(b.month) ||
        a.published!.id.localeCompare(b.published!.id),
    );
  const captures = saved.map((month) => ({
    ...month,
    view: dealerViews(
      summaryDealerRows(month.published!.summary),
      month.published!.summary.excludedVouchers ?? [],
    ),
  }));
  const confirmedNames = new Map<string, Set<string>>();
  for (const month of captures)
    for (const dealer of month.view.dealers) {
      if (!dealer.row || !isWebsiteDealer(dealer)) continue;
      const keys = confirmedNames.get(dealer.name) ?? new Set<string>();
      keys.add(dealer.key);
      confirmedNames.set(dealer.name, keys);
    }
  const merged = new Map<string, DealerView & { keepEmpty: boolean }>();
  const vouchers = new Map<
    string,
    { voucher: DaybookExcludedVoucher; owner: string | null; header?: DaybookBillHeader }
  >();
  const repeated = new Set<string>();
  for (const month of captures) {
    const publication = month.published!;
    function captureVoucher(voucher: DaybookExcludedVoucher, owner: string | null) {
      const id = voucher.guid.toLowerCase();
      if (vouchers.has(id)) repeated.add(id);
      vouchers.set(id, {
        voucher: { ...voucher, sourceJobId: publication.id, sourceMonth: month.month },
        owner,
        header: publication.summary.billHeaders?.[id],
      });
    }
    for (const dealer of month.view.dealers) {
      const exact =
        !dealer.row && isWebsiteDealer(dealer) ? confirmedNames.get(dealer.name) : undefined;
      const key = exact?.size === 1 ? [...exact][0] : dealer.key;
      const previous = merged.get(key);
      const row = dealer.row;
      const combinedRow =
        row && previous?.row
          ? {
              ...row,
              ledgers: [...new Set([...previous.row.ledgers, ...row.ledgers])],
              liveRecovery: sumDisplayAmounts([previous.row.liveRecovery, row.liveRecovery])!,
              srCr: sumDisplayAmounts([previous.row.srCr, row.srCr])!,
              other: sumDisplayAmounts([previous.row.other, row.other]),
            }
          : (row ?? previous?.row);
      merged.set(key, {
        key,
        name: row?.dealerName ?? previous?.name ?? dealer.name,
        row: combinedRow,
        vouchers: [],
        monthlyDetails: [
          ...(previous?.monthlyDetails ?? []),
          ...(row ? [{ month: month.month, row }] : []),
        ],
        incompleteVouchers:
          previous?.incompleteVouchers ||
          missingMonths.length > 0 ||
          publication.summary.coverage !== "all_vouchers" ||
          (!!row &&
            !dealer.vouchers.length &&
            [row.liveRecovery, row.srCr, row.other].some(
              (amount) => amount !== null && Number(amount) !== 0,
            )),
        keepEmpty: !!previous?.keepEmpty || !dealer.vouchers.length,
      });
      for (const voucher of dealer.vouchers) captureVoucher(voucher, key);
    }
    for (const voucher of month.view.unassigned) captureVoucher(voucher, null);
  }
  const unassigned: DaybookExcludedVoucher[] = [],
    billHeaders: DaybookBillHeaders = {};
  for (const [id, capture] of vouchers) {
    if (capture.owner) merged.get(capture.owner)!.vouchers.push(capture.voucher);
    else unassigned.push(capture.voucher);
    if (capture.header) billHeaders[id] = capture.header;
  }
  return {
    view: {
      dealers: [...merged.values()]
        .filter((dealer) => dealer.vouchers.length || dealer.keepEmpty)
        .map(({ keepEmpty: _keep, ...dealer }) => dealer)
        .sort((a, b) => a.name.localeCompare(b.name)),
      unassigned,
    },
    billHeaders,
    missingMonths,
    repeatedVouchers: repeated.size,
    voucherCount: vouchers.size,
    savedMonths: saved.length,
    coverage: saved.every((month) => month.published!.summary.coverage === "all_vouchers")
      ? "all_vouchers"
      : "legacy",
  };
}
