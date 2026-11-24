"use client";
import { useState } from "react";
import Link from "next/link";
import type { DaybookDealerRow, DaybookExcludedVoucher } from "./daybook-result-types";
import { DaybookDealerVouchers } from "./daybook-dealer-vouchers";
import { DaybookVoucherDetails, voucherLabel } from "./daybook-voucher-details";
import {
  dealerDisplayAmounts,
  dealerViews,
  matchesDealerSearch,
  type DealerView,
} from "./daybook-view";
import type { DaybookBillHeaders } from "./daybook-bill-amounts";
import {
  daybookScopes,
  filterDaybookView,
  unclassifiedDaybookCredits,
  type DaybookScope,
} from "./daybook-filters";

const money = (amount: string | null | undefined) =>
  amount == null
    ? "—"
    : Number(amount).toLocaleString("en-IN", { style: "currency", currency: "INR" });
export function DaybookResultTables({
  dealerRows,
  excludedVouchers = [],
  coverage,
  sourceJobId,
  billHeaders = {},
  preparedView,
}: {
  dealerRows: DaybookDealerRow[];
  excludedVouchers?: DaybookExcludedVoucher[];
  coverage?: string;
  sourceJobId?: string;
  billHeaders?: DaybookBillHeaders;
  preparedView?: { dealers: DealerView[]; unassigned: DaybookExcludedVoucher[] };
}) {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<DaybookScope>("all");
  const view = preparedView ?? dealerViews(dealerRows, excludedVouchers);
  const scopes = daybookScopes.map((entry) => ({
    ...entry,
    view: filterDaybookView(view, entry.value, billHeaders),
  }));
  const selected = scopes.find((entry) => entry.value === scope)!;
  const scopedDealers = selected.view.dealers;
  const visible = scopedDealers.filter((dealer) => matchesDealerSearch(dealer, search));
  const unassigned = selected.view.unassigned.filter(
    (voucher) =>
      !search.trim() ||
      [voucher.voucherType, voucher.voucherNumber, voucher.date].some((value) =>
        value.toLowerCase().includes(search.trim().toLowerCase()),
      ),
  );
  const unclassified = unclassifiedDaybookCredits(view, billHeaders);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Daybook view">
        {scopes.map(({ value, label, view: filtered }) => (
          <button
            key={value}
            type="button"
            aria-pressed={scope === value}
            onClick={() => setScope(value)}
            className={`rounded-md border px-3 py-2 text-sm ${
              scope === value
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-background hover:bg-muted"
            }`}
          >
            {label} ({filtered.dealers.length})
          </button>
        ))}
      </div>
      {selected.description && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{selected.description}</p>
          <p>
            Only matching vouchers and their totals are shown. Dealer & matching details retain the
            original full-period totals. Counts show dealers; unassigned vouchers are listed
            separately.
          </p>
          {unclassified > 0 && (
            <p>
              {unclassified} return/credit-note vouchers have incomplete product or quantity
              details. They appear only in filters supported by the saved evidence. Refresh their
              Daybook months for complete details.
            </p>
          )}
        </div>
      )}
      <details aria-label="Daybook dealers" className="rounded-lg border p-4">
        <summary className="cursor-pointer select-none font-medium marker:text-muted-foreground">
          Dealers <span className="text-sm text-muted-foreground">({scopedDealers.length})</span>
        </summary>
        <div className="mt-4 space-y-4">
          <div className="flex justify-end">
            <label className="flex items-center gap-2 text-sm">
              <span className="sr-only">Find dealer or bill</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Find dealer or bill…"
                className="w-full rounded border bg-background px-3 py-2 sm:w-64"
              />
            </label>
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer">ⓘ About these figures</summary>
            <div className="mt-2 space-y-2 rounded border p-3">
              <p>
                Sales, receipts, returns/credit notes and other transactions are grouped under each
                dealer. All records are from the selected Daybook captures.
              </p>
              <p>
                Sales and returns/credit notes show product amounts excluding GST. A dash means the
                product amount is unavailable. Original captured totals remain in Dealer & matching
                details; bill totals and recorded taxes appear inside each bill.
              </p>
              <p>
                Receipts and SR/CR update Recovery only for confirmed dealer matches. Other totals
                are for review and do not update Recovery or Last Payment.
              </p>
              <p>
                Cancelled and optional vouchers appear under Other.{" "}
                {
                  (preparedView
                    ? [
                        ...view.dealers.flatMap((dealer) => dealer.vouchers),
                        ...view.unassigned,
                      ].filter((voucher) => voucher.reason !== "included")
                    : excludedVouchers
                  ).length
                }{" "}
                vouchers are outside the Recovery receipt/SRCR totals.
              </p>
              {coverage !== "all_vouchers" && (
                <p>
                  This older capture covers Receipt and Credit Note families only. Refresh Daybook
                  for the full voucher list.
                </p>
              )}
              <p>
                Needs dealer link means the Tally name has no confirmed website dealer. Review its
                matching details or open{" "}
                <Link className="text-primary underline" href="/planning/dealer-alias">
                  Dealer Alias
                </Link>
                .
              </p>
            </div>
          </details>
          <div className="space-y-3" aria-label="Daybook dealer summary">
            {visible.map((dealer) => (
              <details className="group rounded-lg border" key={dealer.key}>
                <summary className="cursor-pointer select-none p-4 marker:text-muted-foreground">
                  <span className="inline-flex max-w-full flex-wrap items-center gap-x-6 gap-y-2 align-middle">
                    <span className="font-medium">{dealer.name}</span>
                    {dealer.incompleteVouchers && (
                      <span className="text-xs text-muted-foreground">
                        Incomplete period details
                      </span>
                    )}
                    {dealer.row &&
                      ["Needs dealer link", "Prior figures kept"].includes(dealer.row.status) && (
                        <span className="rounded bg-muted px-2 py-0.5 text-xs">
                          {dealer.row.status}
                        </span>
                      )}
                    {!!dealer.vouchers.length ? (
                      <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {dealerDisplayAmounts(dealer, billHeaders).map((entry) => (
                          <span key={entry.label}>
                            {entry.label}{" "}
                            <strong className="font-medium text-foreground">
                              {money(entry.amount)}
                            </strong>
                          </span>
                        ))}
                      </span>
                    ) : (
                      dealer.row && (
                        <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>
                            Receipts{" "}
                            <strong className="font-medium text-foreground">
                              {money(dealer.incompleteVouchers ? null : dealer.row.liveRecovery)}
                            </strong>
                          </span>
                          <span>
                            SR/CR (bill total){" "}
                            <strong className="font-medium text-foreground">
                              {money(dealer.incompleteVouchers ? null : dealer.row.srCr)}
                            </strong>
                          </span>
                          <span>
                            Other (bill totals){" "}
                            <strong className="font-medium text-foreground">
                              {money(dealer.incompleteVouchers ? null : dealer.row.other)}
                            </strong>
                          </span>
                        </span>
                      )
                    )}
                  </span>
                </summary>
                <div className="space-y-4 border-t p-4">
                  {dealer.row && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="w-fit cursor-pointer">
                        ⓘ Dealer & matching details
                        {dealer.row.status === "Needs dealer link" ? " · Needs dealer link" : ""}
                      </summary>
                      <div className="mt-2 space-y-1 rounded border p-3">
                        <p>Status: {dealer.row.status}</p>
                        {dealer.row.ledgers.map((ledger) => (
                          <p key={ledger}>Tally: {ledger}</p>
                        ))}
                        {dealer.row.reason && <p>{dealer.row.reason}</p>}
                        {!!dealer.monthlyDetails?.length && (
                          <details>
                            <summary className="cursor-pointer">
                              Original monthly captures ({dealer.monthlyDetails.length})
                            </summary>
                            {dealer.monthlyDetails.map(({ month, row }) => (
                              <p key={month}>
                                {month} · {row.dealerName} · {row.status} · Receipts{" "}
                                {money(row.liveRecovery)} · SR/CR {money(row.srCr)} · Other{" "}
                                {money(row.other)}
                                {row.reason ? ` · ${row.reason}` : ""}
                              </p>
                            ))}
                          </details>
                        )}
                        <p>
                          {preparedView
                            ? "Sum of original monthly totals"
                            : "Original captured totals"}
                          : Receipts {money(dealer.row.liveRecovery)} · SR/CR{" "}
                          {money(dealer.row.srCr)} · Other {money(dealer.row.other)}
                        </p>
                        {!!dealer.row.candidates?.length && (
                          <p>Possible matches: {dealer.row.candidates.join(", ")}</p>
                        )}
                      </div>
                    </details>
                  )}
                  {!!dealer.vouchers.length ? (
                    <DaybookDealerVouchers
                      excluded={dealer.vouchers}
                      sourceJobId={sourceJobId}
                      billHeaders={billHeaders}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {preparedView
                        ? "No retained voucher details for this dealer. See the original monthly captures for recorded totals."
                        : "This older capture has totals only. Refresh Daybook for individual bills and receipts."}
                    </p>
                  )}
                </div>
              </details>
            ))}
            {!visible.length && (
              <p className="rounded border p-4 text-sm text-muted-foreground">
                {search
                  ? "No dealers or bills match this search."
                  : scope === "dealers"
                    ? "No confirmed website dealers in this capture."
                    : scope !== "all"
                      ? "No dealers have matching vouchers in the selected period."
                      : "No dealer entries in this capture."}
              </p>
            )}
          </div>
          {!!unassigned.length && (
            <details className="rounded-lg border p-4" aria-label="Unassigned vouchers">
              <summary className="cursor-pointer font-medium">
                Unassigned vouchers ({unassigned.length})
              </summary>
              <p className="my-3 text-xs text-muted-foreground">
                No single dealer/party identified. Original ledger and stock details are available
                inside each voucher.
              </p>
              {unassigned.map((voucher) => (
                <DaybookVoucherDetails
                  key={voucher.guid}
                  voucher={voucher}
                  sourceJobId={sourceJobId}
                  billHeader={billHeaders[voucher.guid.toLowerCase()]}
                  summaryLabel={voucherLabel(voucher)}
                  compact
                />
              ))}
            </details>
          )}
        </div>
      </details>
    </div>
  );
}
