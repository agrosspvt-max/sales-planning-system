export type BillLedgerEntry = { name: string; amount: string };

const money = (value: string) => /^-?\d+\.\d{2}$/.test(value)
  ? Number(value).toLocaleString("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : value || "Not recorded";

/** Original accounting evidence only; these lines are never added to report totals. */
export function BillLedgerEntries({ entries, billNumber }: {
  entries?: BillLedgerEntry[];
  billNumber: string;
}) {
  return (
    <section className="space-y-2 rounded border p-3">
      <h4 className="text-sm font-semibold">Ledger entries</h4>
      {!entries?.length ? (
        <p className="text-sm text-muted-foreground">Ledger entries were not recorded in this saved bill.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Original whole-bill amounts as recorded in Tally.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" aria-label={`Ledger entries in bill ${billNumber}`}>
              <thead><tr>
                <th scope="col" className="py-2 pr-4">Ledger</th>
                <th scope="col" className="py-2 text-right">Amount</th>
              </tr></thead>
              <tbody>
                {entries.map((entry, index) => (
                  <tr key={index} className="border-t">
                    <td className="py-2 pr-4 [overflow-wrap:anywhere]">{entry.name}</td>
                    <td className="whitespace-nowrap py-2 text-right tabular-nums">{money(entry.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
