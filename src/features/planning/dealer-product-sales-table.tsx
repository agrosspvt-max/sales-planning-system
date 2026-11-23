"use client";

import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TerritoryDealerSummary } from "./group-dealer-summary";
import type { DealerSalesBills, SalesMeasure } from "./dealer-sales-bills";
import { sameSalesMeasure, sumSalesMeasures } from "./dealer-sales-breakdown";

const money = (value: number) =>
  value.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const qty = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 });
const measures = ["sales", "returns", "creditNotes"] as const;
function Measure({ value }: { value: SalesMeasure | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      <div className={cn("whitespace-nowrap tabular-nums", value.amount < 0 && "text-destructive")}>
        {money(value.amount)}
      </div>
      <div
        className={cn(
          "text-xs tabular-nums text-muted-foreground",
          value.quantity < 0 && "text-destructive",
        )}
      >
        Qty {qty.format(value.quantity)}
      </div>
    </>
  );
}
export function DealerProductSalesTable({
  dealer,
  data,
  pending,
  error,
  retry,
  categoryFiltered,
}: {
  dealer: TerritoryDealerSummary;
  data?: DealerSalesBills;
  pending: boolean;
  error: boolean;
  retry: () => void;
  categoryFiltered: boolean;
}) {
  const splits = new Map((data?.productBreakdown ?? []).map((row) => [row.productId, row]));
  const rows = dealer.products.map((product) => {
    const net = { quantity: product.actualQty, amount: product.actualAmount };
    const source = splits.get(product.productId);
    return {
      productId: product.productId,
      productName: product.productName,
      net,
      split: source?.reconciled && sameSalesMeasure(source.net, net) ? source : null,
    };
  });
  // A sale and a full return can cancel to zero and therefore be absent from the
  // existing net report. Keep that verified movement visible without adding net value.
  if (!categoryFiltered)
    for (const source of splits.values()) {
      if (
        !rows.some((row) => row.productId === source.productId) &&
        source.reconciled &&
        sameSalesMeasure(source.net, { quantity: 0, amount: 0 })
      )
        rows.push({
          productId: source.productId,
          productName: source.productName,
          net: source.net,
          split: source,
        });
    }
  const visible = rows
    .filter(
      (row) =>
        row.net.quantity !== 0 ||
        row.net.amount !== 0 ||
        (row.split &&
          measures.some((key) => row.split![key].quantity !== 0 || row.split![key].amount !== 0)),
    )
    .sort((a, b) => b.net.amount - a.net.amount || a.productName.localeCompare(b.productName));
  const complete =
    !!data &&
    data.breakdownAvailable === true &&
    !pending &&
    visible.every((row) => row.split) &&
    sameSalesMeasure(
      { quantity: 0, amount: sumSalesMeasures(visible.map((row) => row.net)).amount },
      { quantity: 0, amount: dealer.actualAmount },
    );
  const unallocated = (data?.bills ?? []).filter(
    (bill) =>
      !bill.cancelled && !bill.optional && bill.family === "Credit Note" && !bill.items.length,
  );
  const unallocatedTotal = unallocated.every((bill) => bill.unallocatedAmount != null)
    ? sumSalesMeasures(
        unallocated.map((bill) => ({ quantity: 0, amount: bill.unallocatedAmount! })),
      ).amount
    : null;
  return (
    <>
      <div className="space-y-2 border-b p-4 text-sm">
        <p>Sales + Returns + Credit notes = Net sales. Deductions retain their negative signs.</p>
        {pending && (
          <p role="status" className="text-muted-foreground">
            Loading sales, returns and credit notes…
          </p>
        )}
        {error && (
          <p role="alert">
            Unable to load the breakdown.{" "}
            <button type="button" className="text-primary underline" onClick={retry}>
              Try again
            </button>
          </p>
        )}
        {!!data && !complete && !pending && (
          <p className="text-muted-foreground">
            Some bill details do not reconcile with the saved product figures. Their net figures are
            preserved; unavailable breakdowns show a dash.
          </p>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer">ⓘ Breakdown details</summary>
          <div className="mt-2 space-y-2">
            <p>
              The split uses the existing Sales collection and the same dealer, period and
              included-plan filters. No sales figures are recalculated or replaced.
            </p>
            <p>
              Sales Return voucher types appear under Returns. Other Credit Note-family vouchers
              appear under Credit notes, including value-only credits with zero quantity. Cancelled
              and optional vouchers are excluded.
            </p>
            <p>
              Uploaded sales without bill details, changed product matches and months awaiting
              review may have no reliable split. The original net amount remains shown.
            </p>
            {!!data?.heldMonths.length && (
              <p>Months awaiting review: {data.heldMonths.join(", ")}.</p>
            )}
          </div>
        </details>
      </div>
      <Table aria-label="Product sales, returns and credit notes" className="min-w-[42rem]">
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Sales</TableHead>
            <TableHead className="text-right">Returns</TableHead>
            <TableHead className="text-right">Credit notes</TableHead>
            <TableHead className="text-right">Net sales</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row) => (
            <TableRow key={row.productId}>
              <TableCell>{row.productName}</TableCell>
              {measures.map((key) => (
                <TableCell key={key} className="text-right">
                  <Measure value={row.split?.[key] ?? null} />
                </TableCell>
              ))}
              <TableCell className="text-right">
                <Measure value={row.net} />
              </TableCell>
            </TableRow>
          ))}
          {!visible.length && (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                No product sales for this selection.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
        <tfoot>
          <TableRow className="bg-muted/40 font-semibold">
            <TableCell>Total</TableCell>
            {measures.map((key) => (
              <TableCell key={key} className="whitespace-nowrap text-right tabular-nums">
                {complete
                  ? money(sumSalesMeasures(visible.map((row) => row.split![key])).amount)
                  : "—"}
              </TableCell>
            ))}
            <TableCell
              className={cn(
                "whitespace-nowrap text-right tabular-nums",
                dealer.actualAmount < 0 && "text-destructive",
              )}
              aria-label="Net Sales Total"
            >
              {money(dealer.actualAmount)}
            </TableCell>
          </TableRow>
        </tfoot>
      </Table>
      {!!unallocated.length && (
        <details className="m-4 rounded border p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Credit notes without products ({unallocated.length}) ·{" "}
            {unallocatedTotal === null ? "Amount not captured" : money(unallocatedTotal)}
          </summary>
          <p className="my-2 text-xs text-muted-foreground">
            Not assigned to a product and not deducted from the product net above. These are voucher
            totals and may include taxes; category filters cannot allocate them.
          </p>
          <dl className="space-y-2">
            {unallocated.map((bill) => (
              <div key={bill.id} className="flex justify-between gap-4">
                <dt>
                  {bill.number || "Unnumbered credit note"} · {bill.date}
                </dt>
                <dd className="whitespace-nowrap tabular-nums">
                  {bill.unallocatedAmount == null ? "Not captured" : money(bill.unallocatedAmount)}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </>
  );
}
