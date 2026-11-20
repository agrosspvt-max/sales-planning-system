"use client";
import type { DaybookCredit } from "./daybook-preview";
import type { DaybookExcludedVoucher } from "./daybook-result-types";
import { DaybookVoucherDetails } from "./daybook-voucher-details";
import { creditVoucher, groupVouchers, shortVoucherLabel } from "./daybook-view";

export function DaybookDealerVouchers({
  credits = [],
  excluded = [],
  sourceJobId,
}: {
  credits?: DaybookCredit[];
  excluded?: DaybookExcludedVoucher[];
  sourceJobId?: string;
}) {
  const groups = groupVouchers([...credits.map(creditVoucher), ...excluded]);
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
              summaryLabel={shortVoucherLabel(voucher)}
              compact
            />
          ))}
        </section>
      ))}
    </div>
  );
}
