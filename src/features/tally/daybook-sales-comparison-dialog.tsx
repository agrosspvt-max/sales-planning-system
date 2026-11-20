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
import type { ComparisonBill, DaybookSalesComparison } from "./daybook-sales-comparison";

function BillDetails({ bill, label }: { bill?: ComparisonBill; label: string }) {
  if (!bill) return <p>{label}: Bill not present.</p>;
  return (
    <div className="min-w-0 rounded border p-2">
      <p className="font-medium">
        {label}: {bill.party} · {bill.number || "Unnumbered"} · {bill.date}
      </p>
      <p>
        {bill.type}
        {bill.cancelled ? " · Cancelled" : ""}
        {bill.optional ? " · Optional" : ""}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              <th className="p-1">Product</th>
              <th className="p-1">Qty</th>
              <th className="p-1">Unit</th>
              <th className="p-1">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bill.items.map((item, index) => (
              <tr key={index}>
                <td className="p-1">
                  {item.productName}
                  <div className="text-muted-foreground">
                    Actual: {item.actualQty || "Not recorded"} · Billed:{" "}
                    {item.billedQty || "Not recorded"} · Rate: {item.rate || "Not recorded"}
                  </div>
                </td>
                <td className="p-1">{item.quantity}</td>
                <td className="p-1">{item.unit || "—"}</td>
                <td className="p-1">{item.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!!bill.ledgerEntries?.length && (
        <details className="mt-2">
          <summary className="cursor-pointer">Ledger amounts as recorded</summary>
          {bill.ledgerEntries.map((entry, index) => (
            <p key={index}>
              {entry.name}: {entry.amount}
            </p>
          ))}
        </details>
      )}
      {!bill.items.length && <p>No product lines.</p>}
      {bill.itemCount !== undefined && bill.itemCount > bill.items.length && (
        <p>
          Showing {bill.items.length} of {bill.itemCount} product lines. The comparison checks all
          lines.
        </p>
      )}
    </div>
  );
}
export function DaybookComparisonResult({ result }: { result: DaybookSalesComparison }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium" role="status">
        {result.message}
      </p>
      <p>
        Daybook period: {result.fromDate} to {result.throughDate}
        {result.salesThroughDate ? ` · Sales through ${result.salesThroughDate}` : ""}
      </p>
      {result.daybookCapturedAt && (
        <p>
          Daybook captured:{" "}
          {new Date(result.daybookCapturedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
        </p>
      )}
      {result.salesCapturedAt && (
        <p>
          Sales captured:{" "}
          {new Date(result.salesCapturedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
        </p>
      )}
      <p className="text-muted-foreground">
        This compares saved original Sales/Credit Note bills and their product names, quantities,
        units, amounts, quantity text and rates. It also compares financial ledger amounts and
        cancelled/optional flags and preserves repeated product lines. Territory Plan continues to
        use the existing Sales collection. This checks original company bills before Territory plan,
        dealer and product filters.
      </p>
      <p className="text-muted-foreground">
        Captures may have been read at different times. Differences can reflect later Tally edits.
        This check does not replace or update any sales, Recovery or planning figures.
      </p>
      {result.counts && (
        <dl className="grid grid-cols-2 gap-2 rounded border p-3">
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
        <details className="rounded border p-2" key={difference.guid}>
          <summary className="cursor-pointer">
            {difference.reason} · {(difference.daybook ?? difference.sales)?.party} ·{" "}
            {(difference.daybook ?? difference.sales)?.number || "Unnumbered"}
          </summary>
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            <BillDetails bill={difference.daybook} label="Daybook" />
            <BillDetails bill={difference.sales} label="Sales" />
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
