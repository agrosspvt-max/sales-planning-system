"use client";

import { ChevronRight } from "lucide-react";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { DealerTableBody } from "@/features/dealers/dealer-table-ui";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { achievement } from "@/lib/calc";
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
  const totals = rows.reduce(
    (total, row) => ({
      planAmount: total.planAmount + row.planAmount,
      planNbv: total.planNbv + row.planNbv,
      actualAmount: total.actualAmount + row.actualAmount,
      actualNbv: total.actualNbv + row.actualNbv,
    }),
    { planAmount: 0, planNbv: 0, actualAmount: 0, actualNbv: 0 },
  );

  return (
    <div className={cn("rounded-lg border bg-background", externalScroll && "w-max min-w-full")}>
      <Table stickyFirstColumn stickyHeader={externalScroll} externalScroll={externalScroll}>
        <TableHeader>
          <TableRow>
            <TableHead>Dealer</TableHead>
            <TableHead className="text-right">Monthly Plan</TableHead>
            <TableHead className="text-right">Planned NBV</TableHead>
            <TableHead className="text-right text-muted-foreground">Actual Sales</TableHead>
            <TableHead className="text-right text-muted-foreground">Actual NBV</TableHead>
            <TableHead className="text-right">Sales Achv %</TableHead>
            <TableHead className="text-right">NBV Achv %</TableHead>
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
                <TableCell className="text-right tabular-nums">{formatCurrency(r.planAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(r.planNbv)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualAmount)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualNbv)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(achievement(r.actualAmount, r.planAmount))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(achievement(r.actualNbv, r.planNbv))}</TableCell>
              </TableRow>
            ))
          )}
        </DealerTableBody>
        <tfoot>
          <TableRow className="bg-muted/40 font-semibold">
            <TableCell>Total</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.planAmount)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.planNbv)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualAmount)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualNbv)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatPercent(achievement(totals.actualAmount, totals.planAmount))}</TableCell>
            <TableCell className="text-right tabular-nums">{formatPercent(achievement(totals.actualNbv, totals.planNbv))}</TableCell>
          </TableRow>
        </tfoot>
      </Table>
    </div>
  );
}
