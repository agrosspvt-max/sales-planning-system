"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DaybookBillAllocations } from "./daybook-bill-allocations";
import type { DaybookBillProducts, DaybookVoucherSource } from "./daybook-bill-products";

const money = (value: string) =>
  Number(value).toLocaleString("en-IN", { style: "currency", currency: "INR" });
const quantity = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 });

export function DaybookBillProductResult({
  result,
  compact = false,
}: {
  result: DaybookBillProducts;
  compact?: boolean;
}) {
  const bill = result.bill;
  if (result.status !== "matched" || !bill)
    return (
      <div className="space-y-1 text-muted-foreground">
        <p>
          {result.status === "ambiguous"
            ? "More than one Daybook bill matches this reference."
            : result.status === "unlinked"
              ? "No specific bill is linked."
              : "Daybook products are unavailable for this bill."}
        </p>
        {result.message && (
          <details className="text-xs">
            <summary className="w-fit cursor-pointer">ⓘ Details</summary>
            <p className="mt-1">{result.message}</p>
          </details>
        )}
      </div>
    );
  return (
    <div className="space-y-2">
      {!compact && (
        <p className="font-medium">
          Bill {bill.number} · {bill.date}
        </p>
      )}
      {(bill.cancelled || bill.optional) && (
        <p className="font-medium">{bill.cancelled ? "Cancelled bill" : "Optional bill"}</p>
      )}
      <div className="overflow-x-auto rounded border">
        <table
          className="w-full min-w-[24rem] text-left"
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
                Item amount
              </th>
            </tr>
          </thead>
          <tbody>
            {bill.items.map((item) => (
              <tr className="border-t" key={item.lineNo}>
                <td className="p-2">{item.productName}</td>
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
                <td colSpan={4} className="p-2 text-muted-foreground">
                  This saved bill has no product lines.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {bill.amounts && (
        <dl
          className="ml-auto max-w-md space-y-2 rounded border p-3"
          aria-label="Bill amount breakdown"
        >
          <div className="flex justify-between gap-4">
            <dt>Product amount (excl. GST)</dt>
            <dd className="whitespace-nowrap tabular-nums">
              {bill.amounts.subtotal === null ? "Not recorded" : money(bill.amounts.subtotal)}
            </dd>
          </div>
          {bill.amounts.taxes.map((tax, index) => (
            <div key={index} className="flex justify-between gap-4">
              <dt>{tax.name}</dt>
              <dd className="whitespace-nowrap tabular-nums">{money(tax.amount)}</dd>
            </div>
          ))}
          {bill.amounts.adjustments !== null && Number(bill.amounts.adjustments) !== 0 && (
            <div className="flex justify-between gap-4">
              <dt>Other adjustments</dt>
              <dd className="whitespace-nowrap tabular-nums">{money(bill.amounts.adjustments)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4 border-t pt-2 font-medium">
            <dt>Bill total</dt>
            <dd className="whitespace-nowrap tabular-nums">
              {bill.amounts.total === null ? "Not recorded" : money(bill.amounts.total)}
            </dd>
          </div>
        </dl>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer">ⓘ Product details</summary>
        <div className="mt-2 space-y-2 rounded border p-3">
          <p>
            Bill: {bill.number} · {bill.date} · {bill.type}
          </p>
          <p>Tally party: {bill.partyName}</p>
          {result.source === "daybook" && (
            <p>
              Source: Daybook
              {result.capturedAt
                ? ` · ${new Date(result.capturedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
                : ""}
            </p>
          )}
          <p>
            Item amounts are before invoice taxes and charges.
            {!result.ownVoucher &&
              " The amount adjusted against this bill is shown separately above."}
          </p>
          {bill.amounts && (
            <p>
              Taxes use the named Tally ledgers. Other adjustments are the remaining difference,
              including any charges, discounts or round-off; they are not assumed to be GST.
            </p>
          )}
          {!!bill.ledgerEntries?.length && (
            <details>
              <summary className="w-fit cursor-pointer">Original bill ledger amounts</summary>
              <dl className="mt-2 space-y-1">
                {bill.ledgerEntries.map((entry, index) => (
                  <div key={index} className="flex justify-between gap-4">
                    <dt>{entry.name}</dt>
                    <dd className="whitespace-nowrap tabular-nums">{money(entry.amount)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          <p>
            Returns use negative quantities for comparison with Sales. Blank quantities remain
            unrecorded.
          </p>
          {bill.items.some((item) => item.actualQty !== undefined) && (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className="p-1">Product</th>
                    <th className="p-1">Actual qty in Tally</th>
                    <th className="p-1">Billed qty in Tally</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.items.map((item) => (
                    <tr key={item.lineNo}>
                      <td className="p-1">{item.productName}</td>
                      <td className="p-1">{item.actualQty || "Not recorded"}</td>
                      <td className="p-1">{item.billedQty || "Not recorded"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

export function DaybookOwnProducts({
  source,
  compact = false,
  expanded = false,
}: {
  source: DaybookVoucherSource;
  compact?: boolean;
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const params = new URLSearchParams({ ...source, view: "voucher" });
  const query = useQuery({
    queryKey: ["daybook-own-products", source.jobId, source.voucherGuid],
    queryFn: () => api.get<DaybookBillProducts>(`/api/tally/daybook-bill-products?${params}`),
    enabled: compact ? expanded : open,
    staleTime: 60_000,
    retry: false,
  });
  if (compact)
    return (
      <div>
        {expanded && query.isPending && <p role="status">Loading products…</p>}
        {expanded && query.error && <p role="alert">{query.error.message}</p>}
        {expanded && query.data && <DaybookBillProductResult result={query.data} compact />}
      </div>
    );
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
    <details
      aria-label={`Products in bill ${entry.billReference}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="mt-1 rounded border p-2"
    >
      <summary className="cursor-pointer font-medium">View products</summary>
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
