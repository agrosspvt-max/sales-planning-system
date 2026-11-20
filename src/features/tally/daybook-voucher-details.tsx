"use client";

import { useState } from "react";
import type { DaybookExcludedVoucher } from "./daybook-result-types";
import { DaybookBillAllocationTable } from "./daybook-bill-allocation-table";
import { DaybookLedgerLayoutDetails } from "./daybook-ledger-layout-details";
import { DaybookOwnProducts } from "./daybook-referenced-bill-products";

export function voucherLabel(voucher: DaybookExcludedVoucher) {
  return `${voucher.voucherType} · ${voucher.voucherNumber ? `No. ${voucher.voucherNumber}` : "Unnumbered voucher"}`;
}

export function voucherLedgerSummary(voucher: DaybookExcludedVoucher) {
  const evidence = voucher.details?.voucher;
  const names = [
    ...new Set([
      ...(evidence?.ledgerEntries.map((entry) => entry.ledgerName).filter(Boolean) ?? []),
      ...(evidence?.inventoryEntries?.map((entry) => entry.productName).filter(Boolean) ?? []),
    ]),
  ];
  return names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3} more` : "");
}

// These are display-only source amounts, never inputs to Recovery calculations.
function sourceAmount(value?: string | null) {
  const amount = value?.trim();
  return amount && /^-?\d{1,12}(?:\.\d{1,2})?$/.test(amount)
    ? Number(amount).toLocaleString("en-IN", { style: "currency", currency: "INR" })
    : value || "Not returned";
}

const direction = (flag?: string | null) =>
  flag === "Yes" ? "Debit" : flag === "No" ? "Credit" : flag || "Not returned";

export function DaybookVoucherDetails({
  voucher,
  summaryLabel = "Voucher details",
  sourceJobId,
  compact = false,
}: {
  voucher: DaybookExcludedVoucher;
  summaryLabel?: string;
  sourceJobId?: string;
  compact?: boolean;
}) {
  const evidence = voucher.details?.voucher;
  const [open, setOpen] = useState(false);
  const isSale =
    /SALE/i.test(voucher.voucherType) && !/RETURN|CREDIT NOTE/i.test(voucher.voucherType);
  const hasOwnProducts = !!sourceJobId && /SALE|CREDIT NOTE/i.test(voucher.voucherType);
  const mainReferences =
    !isSale ||
    voucher.billAllocations?.entries.some(
      (entry) => entry.referenceType?.trim().toLowerCase() === "agst ref",
    );
  const allocations = (
    <DaybookBillAllocationTable
      allocations={voucher.billAllocations}
      layoutConflict={evidence?.layoutResolution === "conflicting"}
      source={sourceJobId ? { jobId: sourceJobId, voucherGuid: voucher.guid } : undefined}
    />
  );
  return (
    <details
      className="rounded border bg-background text-sm"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      aria-label={`Details for ${voucherLabel(voucher)}`}
    >
      <summary className="cursor-pointer select-none px-3 py-3">
        <span className="inline-flex max-w-full flex-wrap items-center gap-x-4 gap-y-1 align-middle">
          <span className="font-medium">{summaryLabel}</span>
          {compact && (
            <>
              <span className="text-xs text-muted-foreground">
                {new Date(voucher.date + "T00:00:00Z").toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                  timeZone: "Asia/Kolkata",
                })}
              </span>
              {voucher.amount !== undefined && (
                <span className="font-medium tabular-nums">{sourceAmount(voucher.amount)}</span>
              )}
            </>
          )}
          {["cancelled", "optional"].includes(voucher.reason) && (
            <span className="rounded bg-muted px-2 py-0.5 text-xs">
              {voucher.reason === "cancelled" ? "Cancelled" : "Optional"}
            </span>
          )}
        </span>
      </summary>
      <div className="space-y-4 border-t px-3 py-3">
        {hasOwnProducts && (
          <DaybookOwnProducts
            source={{ jobId: sourceJobId!, voucherGuid: voucher.guid }}
            compact
            expanded={open}
          />
        )}
        {mainReferences && allocations}
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer">ⓘ Voucher details</summary>
          <div className="mt-2 space-y-3 rounded border p-3">
            <p>
              {voucherLabel(voucher)} · {voucher.date}
            </p>
            {voucher.amount !== undefined && (
              <p>
                Amount: {sourceAmount(voucher.amount)}
                {voucher.direction && voucher.direction !== "zero"
                  ? ` ${voucher.direction === "debit" ? "Dr" : "Cr"}`
                  : ""}
              </p>
            )}
            {voucher.ledgerName ? (
              <p>Tally ledger: {voucher.ledgerName}</p>
            ) : (
              <p>No single dealer/party identified.</p>
            )}
            <p>
              Status:{" "}
              {{
                included: "Included in Recovery",
                unsupported_type: "Other voucher type",
                VOUCHER_TYPE_NOT_IN_DAYBOOK_RULE: "Other voucher type",
                cancelled: "Cancelled",
                optional: "Optional",
              }[voucher.reason] ?? voucher.reason}
            </p>
            {!mainReferences && allocations}
            {evidence?.ledgerLayouts && <DaybookLedgerLayoutDetails voucher={evidence} />}
            {evidence ? (
              <>
                {evidence.narration && (
                  <p className="whitespace-pre-wrap">Narration: {evidence.narration}</p>
                )}
                {evidence.ledgerEntries.length > 0 &&
                  evidence.layoutResolution !== "conflicting" && (
                    <div className="overflow-x-auto">
                      <p className="mb-1 font-medium">
                        Ledger entries ({evidence.ledgerEntryCount})
                      </p>
                      <table className="w-full text-left">
                        <thead>
                          <tr>
                            <th className="p-1">Ledger</th>
                            <th className="p-1 text-right">Amount as returned</th>
                            <th className="p-1">Dr / Cr</th>
                          </tr>
                        </thead>
                        <tbody>
                          {evidence.ledgerEntries.map((entry) => (
                            <tr key={entry.lineNumber} className="border-t">
                              <td className="p-1">
                                {entry.ledgerName || `Unnamed ledger · line ${entry.lineNumber}`}
                              </td>
                              <td className="whitespace-nowrap p-1 text-right tabular-nums">
                                {sourceAmount(entry.amount)}
                              </td>
                              <td className="p-1">{direction(entry.isDeemedPositive)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {evidence.ledgerEntryCount > evidence.ledgerEntries.length && (
                        <p>
                          Showing the first {evidence.ledgerEntries.length} ledger lines of{" "}
                          {evidence.ledgerEntryCount}.
                        </p>
                      )}
                    </div>
                  )}
                {!!evidence.inventoryEntries?.length && (
                  <div className="overflow-x-auto">
                    <p className="mb-1 font-medium">
                      Stock items (
                      {evidence.inventoryEntryCount ?? evidence.inventoryEntries.length})
                    </p>
                    <table className="w-full text-left">
                      <thead>
                        <tr>
                          <th className="p-1">Product</th>
                          <th className="p-1">Actual qty</th>
                          <th className="p-1">Billed qty</th>
                          <th className="p-1 text-right">Amount as returned</th>
                        </tr>
                      </thead>
                      <tbody>
                        {evidence.inventoryEntries.map((entry) => (
                          <tr key={entry.lineNumber} className="border-t">
                            <td className="p-1">
                              {entry.productName || `Unnamed item · line ${entry.lineNumber}`}
                            </td>
                            <td className="p-1">{entry.actualQty || "Not returned"}</td>
                            <td className="p-1">{entry.billedQty || "Not returned"}</td>
                            <td className="whitespace-nowrap p-1 text-right tabular-nums">
                              {sourceAmount(entry.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {(evidence.inventoryEntryCount ?? 0) > evidence.inventoryEntries.length && (
                      <p>
                        Showing the first {evidence.inventoryEntries.length} stock lines of{" "}
                        {evidence.inventoryEntryCount}.
                      </p>
                    )}
                  </div>
                )}
                {!evidence.ledgerEntries.length && !evidence.inventoryEntries?.length && (
                  <p>No ledger or stock item lines were included in this capture.</p>
                )}
              </>
            ) : voucher.reason !== "included" ? (
              <p>
                This saved capture contains the voucher reference above, but no ledger breakdown.
                Install connector 1.6.6-test and refresh this month to retrieve ledger entries,
                stock items and narration.
              </p>
            ) : null}
            <p className="break-all text-muted-foreground">Voucher ID: {voucher.guid}</p>
          </div>
        </details>
      </div>
    </details>
  );
}
