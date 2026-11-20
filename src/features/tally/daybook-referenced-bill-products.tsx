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
      {result.source === "daybook" && (
        <p className="text-muted-foreground">
          Source: Daybook
          {result.capturedAt
            ? ` · ${new Date(result.capturedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
            : ""}
        </p>
      )}
      {(bill.cancelled || bill.optional) && (
        <p className="font-medium">
          {bill.cancelled ? "Cancelled bill" : "Optional bill"} · excluded from sales totals.
        </p>
      )}
      <p className="text-muted-foreground">
        These are the full original bill’s product lines captured from Daybook before invoice taxes
        and charges.
        {!result.ownVoucher && " The amount adjusted against this bill is shown separately above."}
      </p>
      {result.source === "daybook" && (
        <p className="text-muted-foreground">
          Returns use negative quantities for comparison with Sales. Original Tally quantity text is
          shown with each product.
        </p>
      )}
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
                <td className="p-2">
                  {item.productName}
                  {item.actualQty !== undefined && (
                    <div className="mt-1 text-muted-foreground">
                      Actual: {item.actualQty || "Not recorded"} · Billed:{" "}
                      {item.billedQty || "Not recorded"}
                    </div>
                  )}
                </td>
                <td className="p-2 text-right tabular-nums">
                  {item.actualQty !== undefined && !item.actualQty && !item.billedQty
                    ? "Not recorded"
                    : quantity.format(Number(item.quantity))}
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

export function DaybookOwnProducts({ source }: { source: DaybookVoucherSource }) {
  const [open, setOpen] = useState(false);
  const params = new URLSearchParams({ ...source, view: "voucher" });
  const query = useQuery({
    queryKey: ["daybook-own-products", source.jobId, source.voucherGuid],
    queryFn: () => api.get<DaybookBillProducts>(`/api/tally/daybook-bill-products?${params}`),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  return (
    <details className="rounded border p-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">
        Products recorded in this Daybook voucher
      </summary>
      {open && query.isPending && <p role="status">Loading Daybook products…</p>}
      {open && query.error && <p role="alert">{query.error.message}</p>}
      {open && query.data && <DaybookBillProductResult result={query.data} />}
    </details>
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
