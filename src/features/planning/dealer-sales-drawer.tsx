"use client";

import { DealerName } from "@/features/dealers/dealer-name-ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/utils";
import type { TerritoryDealerSummary } from "./group-dealer-summary";

const quantityFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 });

export function DealerSalesDrawer({
  dealer,
  periodLabel,
  onClose,
  trigger,
}: {
  dealer: TerritoryDealerSummary;
  periodLabel: string;
  onClose: () => void;
  trigger: HTMLButtonElement | null;
}) {
  const sold = dealer.products
    .filter((product) => product.actualQty !== 0 || product.actualAmount !== 0)
    .sort((a, b) => b.actualAmount - a.actualAmount || a.productName.localeCompare(b.productName));

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="bottom-0 left-auto right-0 top-0 flex w-full max-w-lg translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:rounded-none"
        onCloseAutoFocus={(event) => {
          if (trigger?.isConnected) {
            event.preventDefault();
            trigger.focus();
          }
        }}
      >
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle><DealerName id={dealer.dealerId} name={dealer.name} /></DialogTitle>
          <DialogDescription>{periodLabel}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Table aria-label="Product sales for this dealer">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Product</TableHead>
                <TableHead scope="col" className="whitespace-nowrap text-right">Qty Sold</TableHead>
                <TableHead scope="col" className="whitespace-nowrap text-right">Actual Sales</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sold.map((product) => (
                <TableRow key={product.productId}>
                  <TableCell>{product.productName}</TableCell>
                  <TableCell className="text-right tabular-nums">{quantityFormat.format(product.actualQty)}</TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">{formatCurrency(product.actualAmount)}</TableCell>
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
                <TableCell className="whitespace-nowrap text-right tabular-nums">{formatCurrency(dealer.actualAmount)}</TableCell>
              </TableRow>
            </tfoot>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
