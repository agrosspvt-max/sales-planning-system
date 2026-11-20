"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type {
  ComparisonBill,
  ComparisonItem,
  DaybookSalesComparison,
} from "./daybook-sales-comparison";

const recorded = (value: string | null | undefined) => value?.trim() || "Not recorded";
const money = (value: string | null | undefined) =>
  value == null
    ? "Not available in this capture"
    : Number(value).toLocaleString("en-IN", { style: "currency", currency: "INR" });
const capturedAt = (value?: string) =>
  value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "Not recorded";
function ProductLines({
  items,
  copies = false,
}: {
  items: (ComparisonItem & { copies?: number })[];
  copies?: boolean;
}) {
  if (!items.length)
    return <p className="text-muted-foreground">No product lines in this saved capture.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr>
            <th className="p-2">Product</th>
            <th className="p-2">Qty</th>
            <th className="p-2">Unit</th>
            <th className="p-2 text-right">Item amount</th>
            {copies && <th className="p-2">Occurrences</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr className="border-t" key={index}>
              <td className="break-words p-2">
                {item.productName}
                <div className="text-muted-foreground">
                  Actual: {recorded(item.actualQty)} · Billed: {recorded(item.billedQty)} · Rate:{" "}
                  {recorded(item.rate)}
                </div>
              </td>
              <td className="p-2">{item.quantity}</td>
              <td className="p-2">{recorded(item.unit)}</td>
              <td className="whitespace-nowrap p-2 text-right">{money(item.amount)}</td>
              {copies && <td className="p-2">{item.copies ?? 1}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function BillDetails({
  bill,
  label,
  captured,
  compact = false,
}: {
  bill?: ComparisonBill;
  label: string;
  captured?: string;
  compact?: boolean;
}) {
  if (!bill) return <p className="rounded border p-3">{label}: Bill not present.</p>;
  return (
    <section
      className="min-w-0 space-y-3 rounded border p-3"
      aria-label={`${label} saved voucher ${bill.number}`}
    >
      <div>
        <h4 className="font-medium">
          {label}: {bill.number || "Unnumbered"}
        </h4>
        <p>
          {bill.date} · {bill.type}
        </p>
        <p>
          Dealer / party: <strong>{recorded(bill.party)}</strong>
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Recorded cancelled</dt>
          <dd className="font-medium">{bill.cancelled ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Recorded optional</dt>
          <dd className="font-medium">{bill.optional ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Party ledger amount (signed)</dt>
          <dd>{money(bill.partyLedgerAmount)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Product line total (signed)</dt>
          <dd>{money(bill.productTotal)}</dd>
        </div>
        {bill.capturedAmount && (
          <div>
            <dt className="text-muted-foreground">Daybook voucher amount</dt>
            <dd>
              {money(bill.capturedAmount.amount)}{" "}
              {bill.capturedAmount.direction === "debit"
                ? "Dr"
                : bill.capturedAmount.direction === "credit"
                  ? "Cr"
                  : ""}
            </dd>
          </div>
        )}
      </dl>
      {compact ? (
        <p className="text-xs">Product lines: {bill.itemCount ?? bill.items.length}</p>
      ) : (
        <>
          <ProductLines items={bill.items} />
          {bill.itemCount !== undefined && bill.itemCount > bill.items.length && (
            <p className="text-xs">
              Showing {bill.items.length} of {bill.itemCount} product lines. The comparison checks
              all lines.
            </p>
          )}
          {!!bill.ledgerEntries?.length && (
            <details className="text-xs">
              <summary className="cursor-pointer">
                Ledger amounts as recorded ({bill.ledgerCount ?? bill.ledgerEntries.length})
              </summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr>
                      <th className="p-1">Ledger / account</th>
                      <th className="p-1 text-right">Signed amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bill.ledgerEntries.map((entry, index) => (
                      <tr key={index} className="border-t">
                        <td className="p-1">{entry.name}</td>
                        <td className="p-1 text-right">{money(entry.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(bill.ledgerCount ?? 0) > bill.ledgerEntries.length && (
                <p>
                  Showing {bill.ledgerEntries.length} of {bill.ledgerCount} ledger lines. All were
                  compared.
                </p>
              )}
            </details>
          )}
        </>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer">ⓘ Tally identity &amp; source details</summary>
        <dl className="mt-2 space-y-2 break-words">
          <div>
            <dt className="text-muted-foreground">Tally voucher GUID</dt>
            <dd className="break-all">{recorded(bill.guid)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Master ID</dt>
            <dd>{recorded(bill.masterId)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Alter ID (edit version, not a time)</dt>
            <dd>{recorded(bill.alterId)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Voucher family</dt>
            <dd>{recorded(bill.family)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Captured at</dt>
            <dd>{capturedAt(captured)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Cancellation time</dt>
            <dd>Not captured</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last edit time</dt>
            <dd>Not captured</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Raw IsCancelled / IsOptional text</dt>
            <dd>
              {bill.rawCancelled || bill.rawOptional
                ? `${recorded(bill.rawCancelled)} / ${recorded(bill.rawOptional)}`
                : "Original flag text not saved for this source; recorded flags are shown above."}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Narration</dt>
            <dd className="whitespace-pre-wrap">
              {bill.narration || "Not captured in this saved source"}
            </dd>
          </div>
          {bill.references && (
            <div>
              <dt className="text-muted-foreground">
                Creating bill references ({bill.referenceCount ?? bill.references.length})
              </dt>
              <dd>
                {bill.references.length ? bill.references.join(", ") : "None recorded"}
                {(bill.referenceCount ?? 0) > bill.references.length
                  ? ` · Showing ${bill.references.length} of ${bill.referenceCount}`
                  : ""}
              </dd>
            </div>
          )}
        </dl>
      </details>
    </section>
  );
}
export function DaybookComparisonResult({ result }: { result: DaybookSalesComparison }) {
  return (
    <div className="space-y-4 text-sm">
      <p className="font-medium" role="status">
        {result.message}
      </p>
      {result.companyName && <p>Company: {result.companyName}</p>}
      <p>
        Period: {result.fromDate} to {result.throughDate}
        {result.salesThroughDate ? ` · Sales through ${result.salesThroughDate}` : ""}
      </p>
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <p>Daybook captured: {capturedAt(result.daybookCapturedAt)}</p>
        <p>Sales captured: {capturedAt(result.salesCapturedAt)}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Statuses below are from saved captures, not a live Tally check. Capture times are not
        cancellation or edit times.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">ⓘ What is compared</summary>
        <div className="mt-2 space-y-2 rounded border p-3">
          <p>
            Vouchers are paired by Tally GUID, not the printed bill number. The comparison checks
            bill number/date, dealer, voucher type/family, cancelled/optional flags, original
            product quantities/units/amounts/quantity text/rates and financial ledger amounts.
            Repeated lines are checked separately.
          </p>
          <p>
            Territory Plan continues to use the existing Sales collection. This does not replace or
            update any sales, Recovery or planning figures. Different capture times can reflect
            later Tally edits; the saved data cannot establish when or why a voucher was changed or
            cancelled.
          </p>
          {result.daybookJobId && (
            <p className="break-all">Daybook capture ID: {result.daybookJobId}</p>
          )}
          {result.salesSnapshotId && (
            <p className="break-all">Sales snapshot ID: {result.salesSnapshotId}</p>
          )}
        </div>
      </details>
      {result.counts && (
        <dl className="grid grid-cols-2 gap-3 rounded border p-3 sm:grid-cols-3">
          {Object.entries({
            "Daybook bills": result.counts.daybookBills,
            "Sales bills": result.counts.salesBills,
            "Matching bills": result.counts.matchedBills,
            "Different bills": result.counts.differentBills,
            "Only in Daybook": result.counts.onlyDaybook,
            "Only in Sales": result.counts.onlySales,
          }).map(([label, count]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="font-medium">{count}</dd>
            </div>
          ))}
        </dl>
      )}
      {(result.differences ?? []).map((difference) => (
        <details className="rounded border p-3" key={difference.guid}>
          <summary className="cursor-pointer font-medium">
            {difference.reason} · {(difference.daybook ?? difference.sales)?.number || "Unnumbered"}{" "}
            · {(difference.daybook ?? difference.sales)?.party || "Party not recorded"}
          </summary>
          <div className="mt-3 space-y-4">
            <p className="break-all text-xs text-muted-foreground">
              Paired by Tally voucher GUID: {difference.guid}
            </p>
            {!!difference.fields?.length && (
              <div className="overflow-x-auto">
                <table
                  className="w-full text-left text-sm"
                  aria-label="Exact bill field differences"
                >
                  <thead>
                    <tr>
                      <th className="p-2">Different field</th>
                      <th className="p-2">Daybook</th>
                      <th className="p-2">Sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {difference.fields.map((field) => (
                      <tr className="border-t" key={field.field}>
                        <th className="p-2 font-medium">{field.field}</th>
                        <td className="break-words p-2">{recorded(field.daybook)}</td>
                        <td className="break-words p-2">{recorded(field.sales)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(difference.products ?? []).map((product) => (
              <details className="rounded border p-2" key={product.productName}>
                <summary className="cursor-pointer">
                  {product.productName}: {product.fields.join(", ")}
                </summary>
                <div className="mt-2 grid gap-3 lg:grid-cols-2">
                  {(["daybook", "sales"] as const).map((source) => (
                    <div key={source}>
                      <h5 className="font-medium">
                        {source === "daybook" ? "Daybook" : "Sales"} —{" "}
                        {product[source === "daybook" ? "daybookLineCount" : "salesLineCount"]}{" "}
                        differing line(s)
                      </h5>
                      <ProductLines items={product[source]} copies />
                      {product[source].reduce((total, line) => total + line.copies, 0) <
                        product[source === "daybook" ? "daybookLineCount" : "salesLineCount"] && (
                        <p>Showing the first {product[source].length} distinct differing lines.</p>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            ))}
            {!!difference.productDifferenceCount &&
              difference.productDifferenceCount > (difference.products?.length ?? 0) && (
                <p>
                  Showing {difference.products?.length} of {difference.productDifferenceCount}{" "}
                  differing products. All were compared.
                </p>
              )}
            {!!difference.ledgers?.length && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs" aria-label="Exact ledger differences">
                  <thead>
                    <tr>
                      <th className="p-2">Ledger / account</th>
                      <th className="p-2">Daybook signed amounts</th>
                      <th className="p-2">Sales signed amounts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {difference.ledgers.map((ledger) => (
                      <tr className="border-t" key={ledger.name}>
                        <th className="p-2 font-medium">{ledger.name}</th>
                        <td className="p-2">
                          {ledger.daybook.length
                            ? ledger.daybook
                                .map((line) => `${money(line.amount)} × ${line.copies}`)
                                .join("; ")
                            : "No matching line"}
                          {ledger.daybook.reduce((sum, line) => sum + line.copies, 0) <
                            ledger.daybookLineCount &&
                            ` · Showing first ${ledger.daybook.length} distinct lines`}
                        </td>
                        <td className="p-2">
                          {ledger.sales.length
                            ? ledger.sales
                                .map((line) => `${money(line.amount)} × ${line.copies}`)
                                .join("; ")
                            : "No matching line"}
                          {ledger.sales.reduce((sum, line) => sum + line.copies, 0) <
                            ledger.salesLineCount &&
                            ` · Showing first ${ledger.sales.length} distinct lines`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!!difference.ledgerDifferenceCount &&
              difference.ledgerDifferenceCount > (difference.ledgers?.length ?? 0) && (
                <p>
                  Showing {difference.ledgers?.length} of {difference.ledgerDifferenceCount}{" "}
                  differing ledger names. All were compared.
                </p>
              )}
            <div className="grid gap-3 lg:grid-cols-2">
              <BillDetails
                bill={difference.daybook}
                label="Daybook"
                captured={result.daybookCapturedAt}
              />
              <BillDetails
                bill={difference.sales}
                label="Sales"
                captured={result.salesCapturedAt}
              />
            </div>
            {difference.numberMatches && (
              <details className="rounded border p-3">
                <summary className="cursor-pointer">
                  Other vouchers using either printed bill number ({difference.numberMatches.count})
                </summary>
                <p className="my-2 text-xs text-muted-foreground">
                  Checked within these two saved captures for the selected period. These have a
                  different GUID and are separate vouchers.
                </p>
                {difference.numberMatches.vouchers.length ? (
                  <div className="grid gap-3 lg:grid-cols-2">
                    {difference.numberMatches.vouchers.map(({ source, bill }) => (
                      <BillDetails
                        key={`${source}:${bill.guid}`}
                        bill={bill}
                        label={source}
                        captured={
                          source === "Daybook" ? result.daybookCapturedAt : result.salesCapturedAt
                        }
                        compact
                      />
                    ))}
                  </div>
                ) : (
                  <p>
                    No other vouchers with either printed number were found in these saved captures.
                  </p>
                )}
                {difference.numberMatches.count > difference.numberMatches.vouchers.length && (
                  <p>
                    Showing {difference.numberMatches.vouchers.length} of{" "}
                    {difference.numberMatches.count} other source records.
                  </p>
                )}
              </details>
            )}
          </div>
        </details>
      ))}
      {!!result.differenceCount && result.differenceCount > (result.differences?.length ?? 0) && (
        <p>
          Showing the first {result.differences?.length} of {result.differenceCount} bill
          differences. Counts include all bills.
        </p>
      )}
    </div>
  );
}
export function DaybookSalesComparisonDialog({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["daybook-sales-comparison", jobId],
    queryFn: () =>
      api.get<DaybookSalesComparison>(
        `/api/tally/daybook-sales-comparison?jobId=${encodeURIComponent(jobId)}`,
      ),
    enabled: open,
    staleTime: 0,
    retry: false,
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Compare Daybook bill products with Sales">
          <Info className="mr-2 h-4 w-4" />
          Compare with Sales
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Daybook and Sales comparison</DialogTitle>
          <DialogDescription>Read-only check for the selected Daybook period.</DialogDescription>
        </DialogHeader>
        {query.isPending && <p role="status">Comparing saved bill and product records…</p>}
        {query.error && (
          <div role="alert">
            <p>{query.error.message}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry comparison
            </Button>
          </div>
        )}
        {query.data && <DaybookComparisonResult result={query.data} />}
      </DialogContent>
    </Dialog>
  );
}
