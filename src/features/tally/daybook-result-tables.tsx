"use client";

import Link from "next/link";
import type { DaybookDealerRow, DaybookExcludedVoucher } from "./daybook-result-types";

const money = (amount: string | null | undefined) =>
  amount == null
    ? "—"
    : Number(amount).toLocaleString("en-IN", { style: "currency", currency: "INR" });
const reason = (value: string) =>
  ({
    unsupported_type: "Other voucher type",
    VOUCHER_TYPE_NOT_IN_DAYBOOK_RULE: "Other voucher type",
    cancelled: "Cancelled",
    optional: "Optional",
  })[value] ?? value;

export function DaybookResultTables({
  dealerRows,
  excludedVouchers = [],
  coverage,
}: {
  dealerRows: DaybookDealerRow[];
  excludedVouchers?: DaybookExcludedVoucher[];
  coverage?: string;
}) {
  // Existing saved captures already retain the original Tally types. Index both
  // confirmed dealer names and source ledgers so aliases share one type list.
  const typesByParty = new Map<string, Set<string>>();
  for (const voucher of excludedVouchers) {
    if (!["unsupported_type", "VOUCHER_TYPE_NOT_IN_DAYBOOK_RULE"].includes(voucher.reason))
      continue;
    const keys = [
      ...(voucher.dealerName ? ["dealer:" + voucher.dealerName] : []),
      ...(voucher.ledgerName ? ["ledger:" + voucher.ledgerName] : []),
      "voucher:" + voucher.guid,
    ];
    for (const key of keys) {
      const types = typesByParty.get(key) ?? new Set<string>();
      types.add(voucher.voucherType);
      typesByParty.set(key, types);
    }
  }
  function otherTypes(row: DaybookDealerRow) {
    const keys = [
      "dealer:" + row.dealerName,
      ...row.ledgers.map((name) => "ledger:" + name),
      row.key,
    ];
    return [...new Set(keys.flatMap((key) => [...(typesByParty.get(key) ?? [])]))]
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
  }
  return (
    <div className="space-y-5">
      <details className="space-y-2 rounded border p-3" aria-label="Daybook dealer summary">
        <summary className="cursor-pointer select-none font-medium">
          Dealer summary ({dealerRows.length})
        </summary>
        <p className="text-sm text-muted-foreground">
          Receipts and SR/CR update only dealers with a confirmed match. Other shows the total
          amount of other voucher types for review; it does not update Recovery or Last Payment.
        </p>
        {dealerRows.some((row) => row.status === "Needs dealer link") && (
          <p className="text-sm">
            Needs dealer link means there is no confirmed website dealer for this Tally name. Check
            the reason below, then confirm the name in{" "}
            <Link className="text-primary underline" href="/planning/dealer-alias">
              Dealer Alias
            </Link>
            .
          </p>
        )}
        <div className="max-h-[32rem] overflow-auto rounded border">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="sticky top-0 bg-muted text-left">
              <tr>
                {["Dealer", "SR/CR", "Receipts", "Other", "Voucher types / match"].map(
                  (label, i) => (
                    <th
                      scope="col"
                      key={label}
                      className={`border-b p-3 ${i > 0 && i < 4 ? "text-right" : ""}`}
                    >
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {dealerRows.map((row) => (
                <tr key={row.key} className="border-b last:border-0">
                  <td className="p-3 align-top">
                    <div className="font-medium">{row.dealerName}</div>
                    {row.ledgers
                      .filter((ledger) => ledger !== row.dealerName)
                      .map((ledger) => (
                        <div key={ledger} className="text-xs text-muted-foreground">
                          Tally: {ledger}
                        </div>
                      ))}
                  </td>
                  <td className="p-3 text-right align-top tabular-nums">{money(row.srCr)}</td>
                  <td className="p-3 text-right align-top tabular-nums">
                    {money(row.liveRecovery)}
                  </td>
                  <td className="p-3 text-right align-top tabular-nums">{money(row.other)}</td>
                  <td className="p-3 align-top">
                    <div>
                      {row.status === "Review only"
                        ? otherTypes(row) || "Voucher type unavailable"
                        : row.status}
                    </div>
                    {row.status !== "Review only" && otherTypes(row) && (
                      <p className="text-xs text-muted-foreground">
                        Other voucher types: {otherTypes(row)}
                      </p>
                    )}
                    {row.status !== "Review only" && row.reason && (
                      <p className="text-xs text-muted-foreground">{row.reason}</p>
                    )}
                    {!!row.candidates?.length && (
                      <p className="text-xs text-muted-foreground">
                        Possible matches: {row.candidates.join(", ")}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
              {!dealerRows.length && (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-muted-foreground">
                    No dealer entries in this capture.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
      <details className="space-y-2 rounded border p-3" aria-label="Excluded vouchers">
        <summary className="cursor-pointer select-none font-medium">
          Excluded vouchers ({excludedVouchers.length})
        </summary>
        <p className="text-sm text-muted-foreground">
          Voucher types outside Receipt, Credit Note and Sales Return appear here, along with
          cancelled and optional vouchers. Amounts are from the party ledger; Dr/Cr shows its
          direction.
        </p>
        {coverage !== "all_vouchers" && (
          <p className="text-sm text-muted-foreground">
            This capture covers Receipt and Credit Note families only. Install connector 1.6.2-test
            and refresh to include all other voucher types and their dealer amounts.
          </p>
        )}
        <div className="max-h-96 overflow-auto rounded border">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="sticky top-0 bg-muted text-left">
              <tr>
                {[
                  "Dealer / Tally ledger",
                  "Voucher type",
                  "Amount",
                  "Date",
                  "Voucher no.",
                  "Reason",
                ].map((label, i) => (
                  <th
                    scope="col"
                    key={label}
                    className={`border-b p-3 ${i === 2 ? "text-right" : ""}`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {excludedVouchers.map((v) => (
                <tr key={v.guid} className="border-b last:border-0">
                  <td className="p-3 align-top">
                    {v.dealerName ?? v.ledgerName ?? "Not supplied in this capture"}
                    {v.dealerName && v.ledgerName !== v.dealerName && (
                      <div className="text-xs text-muted-foreground">Tally: {v.ledgerName}</div>
                    )}
                  </td>
                  <td className="p-3 align-top">{v.voucherType}</td>
                  <td className="p-3 text-right align-top tabular-nums">
                    {money(v.amount)}
                    {v.amount !== undefined && v.direction !== "zero" && v.direction
                      ? ` ${v.direction === "debit" ? "Dr" : "Cr"}`
                      : ""}
                  </td>
                  <td className="whitespace-nowrap p-3 align-top">{v.date}</td>
                  <td className="p-3 align-top">{v.voucherNumber || "—"}</td>
                  <td className="p-3 align-top">{reason(v.reason)}</td>
                </tr>
              ))}
              {!excludedVouchers.length && (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-muted-foreground">
                    No excluded vouchers in this capture.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {excludedVouchers.some((v) => v.amount === undefined) && (
          <p className="text-xs text-muted-foreground">
            — means the capture did not provide one identifiable party ledger amount.
          </p>
        )}
      </details>
    </div>
  );
}
