"use client";

import type { DaybookDiagnostics } from "./daybook-diagnostics";

export function DaybookLedgerLayoutDetails({
  voucher,
}: {
  voucher: NonNullable<DaybookDiagnostics["voucher"]>;
}) {
  if (!voucher.ledgerLayouts?.length) return null;
  return (
    <section className="space-y-3" aria-label="Comparison of returned ledger sections">
      <h4 className="font-medium">Returned ledger sections</h4>
      <p>
        {voucher.layoutResolution === "conflicting"
          ? "The two sections contain different entries or details. Neither section has been combined or guessed. Compare the original values below; differences can also be in bill references or other nested fields."
          : voucher.layoutResolution === "duplicate"
            ? "The sections contain matching entries, including their nested details. One section is used once."
            : voucher.ledgerLayouts.every((group) => group.meaningfulEntryCount === 0)
              ? "Both sections contain only empty placeholders. No credit entry was identified."
              : "One section contains only empty placeholders. The populated section is used."}
      </p>
      {voucher.ledgerLayouts.map((group) => (
        <div key={group.source} className="space-y-2 rounded border p-2">
          <h5 className="font-medium">{group.source}</h5>
          <p>
            {group.entryCount} returned lines · {group.meaningfulEntryCount} populated ·{" "}
            {group.entryCount - group.meaningfulEntryCount} empty placeholders
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left">
              <thead>
                <tr>
                  {[
                    "Line",
                    "Ledger / bill references",
                    "Amount as returned",
                    "IsDeemedPositive",
                    "IsPartyLedger",
                  ].map((label) => (
                    <th scope="col" className="p-2" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.entries.map((entry) => (
                  <tr key={entry.lineNumber} className="border-t">
                    <td className="p-2 align-top">{entry.lineNumber}</td>
                    <td className="p-2 align-top">
                      {entry.ledgerName || "No ledger name in this line"}
                      {!!entry.billReferences?.length && (
                        <ul className="mt-1 space-y-1 text-xs">
                          {entry.billReferences.map((ref, i) => (
                            <li key={i}>
                              Bill/reference: {ref.name || "No specific reference returned"} ·{" "}
                              {ref.type || "Type unavailable"} ·{" "}
                              {ref.amount || "Amount unavailable"}
                            </li>
                          ))}
                        </ul>
                      )}
                      {(entry.billReferenceCount ?? 0) > (entry.billReferences?.length ?? 0) && (
                        <p className="text-xs">
                          Showing {entry.billReferences?.length ?? 0} of {entry.billReferenceCount}{" "}
                          bill references.
                        </p>
                      )}
                      {entry.sourceHash && (
                        <details className="mt-1 text-xs text-muted-foreground">
                          <summary className="cursor-pointer">Entry content hash</summary>
                          <p className="break-all">{entry.sourceHash}</p>
                        </details>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-2 align-top">
                      {entry.amount || "Not present"}
                    </td>
                    <td className="p-2 align-top">{entry.isDeemedPositive || "Not present"}</td>
                    <td className="p-2 align-top">{entry.isPartyLedger || "Not present"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {group.entryCount > group.entries.length && (
            <p>
              Showing the first {group.entries.length} of {group.entryCount} lines. The original
              response retains all lines.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
