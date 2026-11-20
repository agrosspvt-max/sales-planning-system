"use client";
import type { DaybookCredit } from "./daybook-preview";
import type { DaybookExcludedVoucher } from "./daybook-result-types";
import { DaybookVoucherDetails } from "./daybook-voucher-details";
import { creditVoucher, groupVouchers, shortVoucherLabel } from "./daybook-view";
import type { DaybookBillHeaders } from "./daybook-bill-amounts";

export function DaybookDealerVouchers({
  credits = [],
  excluded = [],
  sourceJobId,
  billHeaders = {},
}: {
  credits?: DaybookCredit[];
  excluded?: DaybookExcludedVoucher[];
  sourceJobId?: string;
  billHeaders?: DaybookBillHeaders;
}) {
  const groups = groupVouchers([...credits.map(creditVoucher), ...excluded], billHeaders);
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.label} aria-label={`${group.label} vouchers`} className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            {group.label}
            <span className="rounded bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
              {group.vouchers.length}
            </span>
          </h3>
          {group.vouchers.map((voucher) => (
            <DaybookVoucherDetails
              key={voucher.guid}
              voucher={voucher}
              sourceJobId={sourceJobId}
              summaryLabel={shortVoucherLabel(voucher, billHeaders[voucher.guid.toLowerCase()])}
              billHeader={billHeaders[voucher.guid.toLowerCase()]}
              compact
            />
          ))}
        </section>
      ))}
    </div>
  );
}
