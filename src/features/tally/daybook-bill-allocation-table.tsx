"use client";

import { Fragment } from "react";
import type { DaybookBillAllocations } from "./daybook-bill-allocations";
import type { DaybookVoucherSource } from "./daybook-bill-products";
import { DaybookReferencedBillProducts } from "./daybook-referenced-bill-products";

function allocationAmount(value?: string | null) {
  const amount = value?.trim();
  return amount && /^[+-]?\d{1,12}(?:\.\d{1,2})?$/.test(amount)
    ? Number(amount).toLocaleString("en-IN", { style: "currency", currency: "INR" })
    : value || "Amount not returned";
}

export function DaybookBillAllocationTable({
  allocations,
  layoutConflict = false,
  source,
}: {
  allocations?: DaybookBillAllocations;
  layoutConflict?: boolean;
  source?: DaybookVoucherSource;
}) {
  const showLedger =
    allocations?.scope === "voucher_ledgers" &&
    new Set(allocations.entries.map((entry) => entry.ledgerName)).size > 1;
  return (
    <div className="space-y-2">
      <p className="font-medium">
        Bill adjustments{allocations ? ` (${allocations.entryCount})` : ""}
      </p>
      {layoutConflict ? (
        <p>
          The ledger sections conflict, so no combined bill-allocation list is shown. Review the
          separate sections below.
        </p>
      ) : !allocations ? (
        <p>
          This saved capture has no bill-allocation details. Install connector 1.6.6-test and
          refresh this month to read the bill references and amounts recorded in Tally.
        </p>
      ) : !allocations.entries.length ? (
        <p>
          Tally returned no bill allocations for this voucher
          {allocations.scope === "selected_credit" ? "’s selected party ledger" : ""}. No specific
          bill can be identified from this capture.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr>
                  {showLedger && <th className="p-1">Ledger</th>}
                  <th className="p-2">Bill / reference</th>
                  <th className="p-2">Type</th>
                  <th className="p-1 text-right">Amount adjusted</th>
                </tr>
              </thead>
              <tbody>
                {allocations.entries.map((entry) => {
                  const type = entry.referenceType?.trim().toLowerCase();
                  const noSpecificBill = type === "on account" || type === "advance";
                  return (
                    <Fragment key={`${entry.ledgerLineNumber}:${entry.allocationNumber}`}>
                      <tr className="border-t">
                        {showLedger && (
                          <td className="p-1">
                            {entry.ledgerName || `Ledger line ${entry.ledgerLineNumber}`}
                          </td>
                        )}
                        <td className="p-1">
                          {entry.billReference ||
                            (noSpecificBill ? "No specific bill" : "Bill reference not returned")}
                        </td>
                        <td className="p-1">{entry.referenceType || "Type not returned"}</td>
                        <td className="whitespace-nowrap p-1 text-right tabular-nums">
                          {allocationAmount(entry.amount)}
                        </td>
                      </tr>
                      {type === "agst ref" && !!entry.billReference?.trim() && (
                        <tr>
                          <td colSpan={showLedger ? 4 : 3} className="p-1 pb-2">
                            <DaybookReferencedBillProducts source={source} entry={entry} />
                          </td>
                        </tr>
                      )}
                      {noSpecificBill && (
                        <tr>
                          <td
                            colSpan={showLedger ? 4 : 3}
                            className="p-1 pb-2 text-muted-foreground"
                          >
                            {entry.referenceType}: no specific bill.
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer">ⓘ Reference details</summary>
            <div className="mt-2 space-y-1 rounded border p-2">
              <p>
                Bill/reference names, types and signed amounts are as recorded in Tally. Advance and
                on-account entries may have no specific bill.
              </p>
              {!showLedger && allocations.scope === "voucher_ledgers" && (
                <p>Ledger: {allocations.entries[0]?.ledgerName || "Not recorded"}</p>
              )}
              {allocations.entries.map((entry) => (
                <p key={`${entry.ledgerLineNumber}:${entry.allocationNumber}`}>
                  Ledger line {entry.ledgerLineNumber} · Allocation {entry.allocationNumber}
                </p>
              ))}
            </div>
          </details>
          {allocations.entryCount > allocations.entries.length && (
            <p>
              Showing the first {allocations.entries.length} of {allocations.entryCount}{" "}
              allocations. Check Tally for the remaining references.
            </p>
          )}
        </>
      )}
    </div>
  );
}
