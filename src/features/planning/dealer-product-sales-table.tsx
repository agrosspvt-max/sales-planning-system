"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
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
import { dealerCreditAdjustment } from "./dealer-credit-adjustments";
import { DealerCreditRows } from "./dealer-credit-rows";

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
        {value.units?.length ? value.units.map(row => `${qty.format(row.quantity)} ${row.unit}`).join(" · ") : `Qty ${qty.format(value.quantity)}`}
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
  const [totalsExpanded, setTotalsExpanded] = useState(false);
  const salesBeforeCredits = dealer.salesBeforeCredits ?? dealer.actualAmount;
  const nbvBeforeCredits = dealer.nbvBeforeCredits ?? dealer.actualNbv;
  const splits = new Map((data?.productBreakdown ?? []).map((row) => [row.productId, row]));
  const rows = dealer.products.map((product) => {
    const net: SalesMeasure = { quantity: product.actualQty, amount: product.actualAmount, units: product.actualUnits };
    const source = splits.get(product.productId);
    return {
      productId: product.productId,
      productName: product.productName,
      net,
      actualNbv: product.actualNbv,
      nbvPending: !!product.nbvPending,
      reviewNotice: product.reviewNotice,
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
          actualNbv: 0,
          nbvPending: false,
          reviewNotice: undefined,
          split: source,
        });
    }
  const visible = rows
    .filter(
      (row) =>
        row.net.quantity !== 0 ||
        row.net.amount !== 0 ||
        row.actualNbv !== 0 ||
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
      { quantity: 0, amount: salesBeforeCredits },
    );
  const movementTotals = Object.fromEntries(measures.map((key) => [key,
    complete ? sumSalesMeasures(visible.map((row) => row.split![key])).amount : null,
  ])) as Record<(typeof measures)[number], number | null>;
  const unallocated = (data?.bills ?? []).filter(
    (bill) =>
      !bill.cancelled && !bill.optional && bill.family === "Credit Note" && !bill.items.length,
  );
  const adjustment =
    dealer.creditAdjustment ??
    dealerCreditAdjustment(
      salesBeforeCredits,
      nbvBeforeCredits,
      {
        unavailable: !data || pending || error || data.breakdownAvailable !== true,
        notes: unallocated.map((bill) => ({
          id: bill.id,
          guid: bill.guid,
          monthKey: bill.date.slice(0, 7),
          date: bill.date,
          number: bill.number,
          type: bill.type,
          amount: bill.unallocatedAmount ?? null,
        })),
      },
      categoryFiltered,
    );
  return (
    <>
      <div className="space-y-2 border-b p-4 text-sm">
        <p>
          Product totals include returns and product-linked credits. Additional credit notes are
          deducted below to show Net Sales.
        </p>
        {rows.filter(row => row.reviewNotice).map(row => <p key={row.productId} role="status" className="text-warning">{row.reviewNotice}</p>)}
        {adjustment.reason && <p className="text-sm text-muted-foreground">{adjustment.reason}</p>}
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
              included-plan filters. Product figures are preserved. Dealer Net Sales deducts the
              additional credit notes below once.
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
            <p>
              Product NBV is preserved. Additional credits reduce total NBV using Total NBV divided
              by Adjusted Sales, before the additional credit notes below.
            </p>
            {!!data?.heldMonths.length && (
              <p>Months awaiting review: {data.heldMonths.join(", ")}.</p>
            )}
          </div>
        </details>
      </div>
      <Table aria-label="Product sales, returns and credit notes"
        className="min-w-[56rem] table-fixed [&_tr>th:last-child]:pr-8 [&_tr>td:last-child]:pr-8">
        <colgroup><col className="w-28" /><col span={5} /></colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Sales</TableHead>
            <TableHead className="text-right">Returns</TableHead>
            <TableHead className="text-right">Credit notes</TableHead>
            <TableHead className="text-right" title="Sales after returns and product-linked credits, before additional credit notes">Adjusted Sales</TableHead>
            <TableHead className="text-right">NBV Sales</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row) => (
            <TableRow key={row.productId}>
              <TableCell className="break-words">{row.productName}{row.reviewNotice && <p className="mt-1 text-xs text-warning" title={row.reviewNotice}>Match review</p>}</TableCell>
              {measures.map((key) => (
                <TableCell key={key} className="text-right">
                  <Measure value={row.split?.[key] ?? null} />
                </TableCell>
              ))}
              <TableCell className="text-right">
                <Measure value={row.net} />
              </TableCell>
              <TableCell className={cn("whitespace-nowrap text-right tabular-nums", row.actualNbv < 0 && "text-destructive")}>
                {row.nbvPending ? "Pending" : money(row.actualNbv)}
              </TableCell>
            </TableRow>
          ))}
          {!visible.length && (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                No product sales for this selection.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
        <tfoot>
          <TableRow className="bg-muted/20 text-xs text-muted-foreground">
            <TableCell className="py-1.5">
              <button type="button" aria-label={totalsExpanded ? "Hide original totals" : "Show original totals"}
                aria-expanded={totalsExpanded} onClick={() => setTotalsExpanded(!totalsExpanded)}
                className="inline-flex items-center gap-1.5 rounded-sm p-0.5">
                <ChevronDown aria-hidden="true" className={cn("h-3 w-3 transition-transform", totalsExpanded && "rotate-180")} /> Total
              </button>
            </TableCell>
            {measures.map((key) => (
              <TableCell
                key={key}
                className="whitespace-nowrap py-1.5 text-right tabular-nums"
              >
                {totalsExpanded ? movementTotals[key] === null ? "—" : money(movementTotals[key]) : null}
              </TableCell>
            ))}
            <TableCell
              className={cn(
                "whitespace-nowrap py-1.5 text-right tabular-nums",
                salesBeforeCredits < 0 && "text-destructive",
              )}
              aria-label="Adjusted Sales Total"
            >
              {totalsExpanded ? money(salesBeforeCredits) : null}
            </TableCell>
            <TableCell
              className={cn("whitespace-nowrap py-1.5 text-right tabular-nums", nbvBeforeCredits < 0 && "text-destructive")}
              aria-label="NBV Sales Total"
            >
              {totalsExpanded ? dealer.nbvPending ? "Pending" : money(nbvBeforeCredits) : null}
            </TableCell>
          </TableRow>
          <DealerCreditRows adjustment={adjustment} productTotals={movementTotals} />
        </tfoot>
      </Table>
    </>
  );
}
