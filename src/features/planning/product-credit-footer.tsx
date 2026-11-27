"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight, MinusCircle } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn, formatCurrency } from "@/lib/utils";
import type { ProductCreditSummary } from "./product-credit-summary";
const money = (value: number) =>
  value.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export interface ProductFooterColumn {
  key: string;
  format: string;
  sectionStart?: boolean;
  comparison?: boolean;
}
export function ProductCreditFooter({
  columns,
  totals,
  summary,
  onOpenCredits,
  unavailableColumns = {},
}: {
  columns: ProductFooterColumn[];
  totals: number[];
  unavailableColumns?: Record<string, string>;
  summary?: ProductCreditSummary;
  onOpenCredits: (trigger: HTMLButtonElement) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const quantity = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 });
  const rows = summary
    ? [
        {
          label: "Credit Notes",
          sales: summary.applied ? summary.creditAmount : null,
          nbv: summary.applied ? summary.nbvAdjustment : null,
          adjustment: true,
        },
        { label: "Net Sales", sales: summary.netSales, nbv: summary.netNbv, adjustment: false },
      ]
    : [];
  return (
    <tfoot>
      <TableRow className="bg-muted/20 text-xs text-muted-foreground">
        <TableCell className="py-1.5">
          <button
            type="button"
            aria-label={expanded ? "Hide original totals" : "Show original totals"}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1.5 rounded-sm p-0.5"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
            />{" "}
            Total
          </button>
        </TableCell>
        {columns.map((column, index) => (
          <TableCell
            key={column.key}
            className={cn(
              "py-1.5 text-right tabular-nums",
              column.sectionStart && "border-l",
              column.comparison && totals[index] < 0 && "text-destructive",
            )}
          >
            {expanded
              ? unavailableColumns[column.key] ?? (column.format === "currency"
                ? formatCurrency(totals[index])
                : quantity.format(totals[index]))
              : null}
          </TableCell>
        ))}
      </TableRow>
      {rows.map((row) => (
        <TableRow
          key={row.label}
          data-financial-adjustment={row.adjustment ? "credit-notes" : "net-sales"}
          className={
            row.adjustment
              ? "border-t-2 border-destructive/30 bg-destructive/5 font-semibold text-destructive hover:bg-destructive/10"
              : "border-t-2 bg-primary/10 font-bold hover:bg-primary/10"
          }
        >
          <TableCell className="whitespace-nowrap py-3">
            {row.adjustment ? (
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={(event) => onOpenCredits(event.currentTarget)}
                className="inline-flex items-center gap-1.5 rounded-sm text-left focus-visible:outline focus-visible:outline-2"
              >
                <MinusCircle aria-hidden="true" className="h-4 w-4" /> Credit Notes{" "}
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            ) : (
              row.label
            )}
          </TableCell>
          {columns.map((column, index) => (
            <TableCell
              key={column.key}
              className={cn("py-3 text-right tabular-nums", column.sectionStart && "border-l",
                !row.adjustment && column.comparison && totals[index] < 0 && "text-destructive")}
              aria-label={
                column.key === "actualAmount"
                  ? `${row.label} Amount`
                  : column.key === "actualNbv"
                    ? `${row.label} NBV`
                    : undefined
              }
            >
              {column.key === "actualAmount"
                ? row.sales === null
                  ? "—"
                  : money(row.sales)
                : column.key === "actualNbv"
                  ? row.nbv === null
                    ? summary?.nbvPending ? "Pending" : "—"
                    : money(row.nbv)
                  : row.adjustment
                    ? null
                    : unavailableColumns[column.key] ?? (column.format === "currency"
                      ? formatCurrency(totals[index])
                      : quantity.format(totals[index]))}
            </TableCell>
          ))}
        </TableRow>
      ))}
      {summary?.applied && summary.reason && (
        <TableRow>
          <TableCell colSpan={columns.length + 1} className="py-2 text-xs text-muted-foreground">
            <p role="status">{summary.reason}</p>
          </TableCell>
        </TableRow>
      )}
    </tfoot>
  );
}
