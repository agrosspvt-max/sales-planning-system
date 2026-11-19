"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { DealerBillList } from "./dealer-bill-list";
import type { DealerSalesBills } from "./dealer-sales-bills";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/utils";
import type { TerritoryDealerSummary } from "./group-dealer-summary";

const quantityFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 });

export function DealerSalesDrawer({
  dealer,
  periodLabel,
  onClose,
  trigger,
  groupId,
  queryParams,
  categoryFiltered,
}: {
  dealer: TerritoryDealerSummary;
  periodLabel: string;
  onClose: () => void;
  trigger: HTMLButtonElement | null;
  groupId: string;
  queryParams: string;
  categoryFiltered: boolean;
}) {
  const [mode, setMode] = useState<"bill" | "product">("product");
  const params = new URLSearchParams(queryParams);
  params.set("dealerId", dealer.dealerId);
  const bills = useQuery<DealerSalesBills>({
    queryKey: ["dealer-sales-bills", groupId, params.toString()],
    queryFn: () => api.get(`/api/planning/groups/${groupId}/dealer-sales-bills?${params}`),
    enabled: mode === "bill",
    refetchInterval: mode === "bill" ? 60000 : false,
  });
  const sold = dealer.products
    .filter((product) => product.actualQty !== 0 || product.actualAmount !== 0)
    .sort((a, b) => b.actualAmount - a.actualAmount || a.productName.localeCompare(b.productName));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="bottom-0 left-auto right-0 top-0 flex w-full max-w-2xl translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:rounded-none"
        onCloseAutoFocus={(event) => {
          if (trigger?.isConnected) {
            event.preventDefault();
            trigger.focus();
          }
        }}
      >
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle>
            <DealerName id={dealer.dealerId} name={dealer.name} />
          </DialogTitle>
          <DialogDescription>{periodLabel}</DialogDescription>
        </DialogHeader>

        <div role="tablist" aria-label="Dealer sales view" className="flex gap-1 border-b px-4">
          {(
            [
              { key: "bill", label: "Bill wise" },
              { key: "product", label: "Product wise" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={mode === tab.key}
              onClick={() => setMode(tab.key)}
              className={cn(
                "border-b-2 px-3 py-3 text-sm font-medium",
                mode === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          role="tabpanel"
          aria-label={mode === "bill" ? "Bill wise sales" : "Product wise sales"}
        >
          {mode === "bill" ? (
            <>
              {bills.isPending && (
                <p role="status" className="p-4 text-sm text-muted-foreground">
                  Loading bills…
                </p>
              )}
              {bills.error && (
                <p role="alert" className="p-4 text-sm">
                  Unable to load bills.{" "}
                  <button
                    type="button"
                    className="text-primary underline"
                    onClick={() => void bills.refetch()}
                  >
                    Try again
                  </button>
                </p>
              )}
              {!!bills.data?.heldMonths.length && (
                <p className="p-4 pb-0 text-sm text-muted-foreground">
                  Bill details from the latest read are awaiting review for{" "}
                  {bills.data.heldMonths.join(", ")}. Product totals retain the last verified
                  figures.
                </p>
              )}
              {bills.data && (
                <DealerBillList
                  key={
                    queryParams +
                    String(categoryFiltered) +
                    dealer.products.map((p) => p.productId).join(",")
                  }
                  bills={bills.data.bills}
                  productIds={dealer.products.map((p) => p.productId)}
                  categoryFiltered={categoryFiltered}
                />
              )}
            </>
          ) : (
            <Table aria-label="Product sales for this dealer">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Product</TableHead>
                  <TableHead scope="col" className="whitespace-nowrap text-right">
                    Qty Sold
                  </TableHead>
                  <TableHead scope="col" className="whitespace-nowrap text-right">
                    Actual Sales
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sold.map((product) => (
                  <TableRow key={product.productId}>
                    <TableCell>{product.productName}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {quantityFormat.format(product.actualQty)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {formatCurrency(product.actualAmount)}
                    </TableCell>
                  </TableRow>
                ))}
                {sold.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                      No product sales for this selection.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              <tfoot>
                <TableRow className="bg-muted/40 font-semibold">
                  <TableCell colSpan={2}>Total Sales</TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {formatCurrency(dealer.actualAmount)}
                  </TableCell>
                </TableRow>
              </tfoot>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
