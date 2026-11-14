"use client";

import { ChevronRight } from "lucide-react";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { DealerTableBody } from "@/features/dealers/dealer-table-ui";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dealerFinancialTotals, dealerPlanColumns } from "./group-plan-export";
import { cn, formatCurrency, formatPercent } from "@/lib/utils";

export interface DealerFinancialRow {
  dealerId: string;
  name: string;
  planAmount: number;
  planNbv: number;
  actualAmount: number;
  actualNbv: number;
}

export function DealerFinancialSummaryTable({
  rows,
  externalScroll = false,
  emptyMessage = "No dealers.",
  onDealerSelect,
}: {
  rows: DealerFinancialRow[];
  externalScroll?: boolean;
  emptyMessage?: string;
  onDealerSelect?: (dealerId: string, trigger: HTMLButtonElement) => void;
}) {
  const totals = dealerFinancialTotals(rows);

  return (
    <div className={cn("rounded-lg border bg-background", externalScroll && "w-max min-w-full")}>
      <Table stickyFirstColumn stickyHeader={externalScroll} externalScroll={externalScroll}>
        <TableHeader>
          <TableRow>
            <TableHead>Dealer</TableHead>
            {dealerPlanColumns.map((column) => (
              <TableHead key={column.key} className="text-right">{column.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <DealerTableBody>
          {rows.length === 0 ? (
            <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{emptyMessage}</TableCell></TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.dealerId} data-dealer-id={r.dealerId}>
                <TableCell className="font-medium">
                  {onDealerSelect ? (
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      className="inline-flex items-center gap-1 rounded-sm text-left text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                      onClick={(event) => onDealerSelect(r.dealerId, event.currentTarget)}
                    >
                      <span><DealerName id={r.dealerId} name={r.name} /></span>
                      <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    </button>
                  ) : (
                    <DealerName id={r.dealerId} name={r.name} />
                  )}
                </TableCell>
                {dealerPlanColumns.map((column) => (
                  <TableCell key={column.key} className={cn("text-right tabular-nums",
                    (column.key === "actualAmount" || column.key === "actualNbv") && "text-muted-foreground")}>
                    {column.format === "percent" ? formatPercent(column.value(r)) : formatCurrency(column.value(r))}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </DealerTableBody>
        <tfoot>
          <TableRow className="bg-muted/40 font-semibold">
            <TableCell>Total</TableCell>
            {dealerPlanColumns.map((column) => (
              <TableCell key={column.key} className="text-right tabular-nums">
                {column.format === "percent" ? formatPercent(column.value(totals)) : formatCurrency(column.value(totals))}
              </TableCell>
            ))}
          </TableRow>
        </tfoot>
      </Table>
    </div>
  );
}
