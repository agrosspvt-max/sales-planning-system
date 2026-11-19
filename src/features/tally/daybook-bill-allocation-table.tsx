"use client";

import type { DaybookBillAllocations } from "./daybook-bill-allocations";

function allocationAmount(value?: string | null) {
  const amount = value?.trim();
  return amount && /^[+-]?\d{1,12}(?:\.\d{1,2})?$/.test(amount)
    ? Number(amount).toLocaleString("en-IN", { style: "currency", currency: "INR" })
    : value || "Amount not returned";
}

export function DaybookBillAllocationTable({
  allocations,
  layoutConflict = false,
}: {
  allocations?: DaybookBillAllocations;
  layoutConflict?: boolean;
}) {
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
          <p className="text-muted-foreground">
            Bill/reference names and types are as recorded in Tally. Advance and on-account entries
            may have no specific bill. Amounts retain their original signs.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr>
                  {allocations.scope === "voucher_ledgers" && <th className="p-1">Ledger</th>}
                  <th className="p-1">Bill / reference no.</th>
                  <th className="p-1">Reference type</th>
                  <th className="p-1 text-right">Amount adjusted</th>
                </tr>
              </thead>
              <tbody>
                {allocations.entries.map((entry) => {
                  const type = entry.referenceType?.trim().toLowerCase();
                  const noSpecificBill = type === "on account" || type === "advance";
                  return (
                    <tr
                      key={`${entry.ledgerLineNumber}:${entry.allocationNumber}`}
                      className="border-t"
                    >
                      {allocations.scope === "voucher_ledgers" && (
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
                  );
                })}
              </tbody>
            </table>
          </div>
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
