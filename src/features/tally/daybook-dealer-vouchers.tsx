"use client";

import type { DaybookCredit } from "./daybook-preview";
import type { DaybookExcludedVoucher } from "./daybook-result-types";
import { DaybookVoucherDetails, voucherLabel } from "./daybook-voucher-details";

export function DaybookDealerVouchers({
  credits = [],
  excluded = [],
  sourceJobId,
}: {
  credits?: DaybookCredit[];
  excluded?: DaybookExcludedVoucher[];
  sourceJobId?: string;
}) {
  const vouchers: DaybookExcludedVoucher[] = [
    ...credits.map((v) => ({ ...v, amount: v.creditAmount, reason: "included" })),
    ...excluded,
  ].sort((a, b) => b.date.localeCompare(a.date) || a.guid.localeCompare(b.guid));
  return (
    <details className="mt-2 rounded border p-2 text-xs">
      <summary className="cursor-pointer font-medium">
        Vouchers / bill adjustments ({vouchers.length})
      </summary>
      {vouchers.map((voucher) => (
        <DaybookVoucherDetails
          key={voucher.guid}
          voucher={voucher}
          sourceJobId={sourceJobId}
          summaryLabel={`${voucherLabel(voucher)} · ${voucher.date}${voucher.amount !== undefined ? ` · ${Number(voucher.amount).toLocaleString("en-IN", { style: "currency", currency: "INR" })}` : ""}`}
        />
      ))}
    </details>
  );
}
