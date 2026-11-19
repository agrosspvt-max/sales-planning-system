"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DaybookBillAllocations } from "./daybook-bill-allocations";
import type { DaybookBillProducts, DaybookVoucherSource } from "./daybook-bill-products";

const money = (value: string) =>
  Number(value).toLocaleString("en-IN", { style: "currency", currency: "INR" });
const quantity = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 });

export function DaybookBillProductResult({ result }: { result: DaybookBillProducts }) {
  const bill = result.bill;
  if (result.status !== "matched" || !bill)
    return <p className="mt-2 text-muted-foreground">{result.message}</p>;
  return (
    <div className="mt-2 space-y-2">
      <p className="font-medium">
        Bill {bill.number} · {bill.date} · {bill.type}
      </p>
      <p className="text-muted-foreground">Tally party: {bill.partyName}</p>
      {(bill.cancelled || bill.optional) && (
        <p className="font-medium">
          {bill.cancelled ? "Cancelled bill" : "Optional bill"} · excluded from sales totals.
        </p>
      )}
      <p className="text-muted-foreground">
        These are the full original bill’s product lines before invoice taxes and charges. The
        amount adjusted by this payment is shown separately above.
      </p>
      <div className="overflow-x-auto rounded border">
        <table
          className="w-full min-w-[26rem] text-left"
          aria-label={`Products in referenced bill ${bill.number}`}
        >
          <thead>
            <tr>
              <th scope="col" className="p-2">
                Product
              </th>
              <th scope="col" className="p-2 text-right">
                Qty
              </th>
              <th scope="col" className="p-2">
                Unit
              </th>
              <th scope="col" className="p-2 text-right">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {bill.items.map((item) => (
              <tr className="border-t" key={item.lineNo}>
                <td className="p-2">{item.productName}</td>
                <td className="p-2 text-right tabular-nums">
                  {quantity.format(Number(item.quantity))}
                </td>
                <td className="p-2">{item.unit || "—"}</td>
                <td className="whitespace-nowrap p-2 text-right tabular-nums">
                  {money(item.amount)}
                </td>
              </tr>
            ))}
            {!bill.items.length && (
              <tr>
                <td colSpan={4} className="p-2">
                  This saved bill has no product lines.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Entry = DaybookBillAllocations["entries"][number];
function SavedBillQuery({ source, entry }: { source: DaybookVoucherSource; entry: Entry }) {
  const [open, setOpen] = useState(false);
  const params = new URLSearchParams({
    jobId: source.jobId,
    voucherGuid: source.voucherGuid,
    ledgerLineNumber: String(entry.ledgerLineNumber),
    allocationNumber: String(entry.allocationNumber),
    reference: entry.billReference ?? "",
  });
  const query = useQuery({
    queryKey: [
      "tally-daybook-bill-products",
      source.jobId,
      source.voucherGuid,
      entry.ledgerLineNumber,
      entry.allocationNumber,
      entry.billReference,
    ],
    queryFn: () => api.get<DaybookBillProducts>(`/api/tally/daybook-bill-products?${params}`),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="rounded border p-2">
      <summary className="cursor-pointer font-medium">
        Products in bill {entry.billReference}
      </summary>
      {open && query.isPending && (
        <p className="mt-2" role="status">
          Loading bill products…
        </p>
      )}
      {open && query.error && (
        <div className="mt-2" role="alert">
          <p>{query.error.message}</p>
          <button type="button" className="mt-1 underline" onClick={() => void query.refetch()}>
            Retry loading products
          </button>
        </div>
      )}
      {open && query.data && <DaybookBillProductResult result={query.data} />}
    </details>
  );
}

export function DaybookReferencedBillProducts({
  source,
  entry,
}: {
  source?: DaybookVoucherSource;
  entry: Entry;
}) {
  if (!source)
    return (
      <p className="text-muted-foreground">
        Bill products can be opened from a published Daybook capture.
      </p>
    );
  return <SavedBillQuery source={source} entry={entry} />;
}
