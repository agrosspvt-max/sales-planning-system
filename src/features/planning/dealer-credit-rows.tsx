"use client";
import { useState } from "react";
import { ChevronRight, MinusCircle } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { DealerCreditAdjustment } from "./dealer-credit-adjustments";
const money = (value: number | null) =>
  value === null
    ? "—"
    : value.toLocaleString("en-IN", {
        style: "currency",
        currency: "INR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
export function DealerCreditRows({ adjustment, productTotals }: {
  adjustment: DealerCreditAdjustment;
  productTotals?: { sales: number | null; returns: number | null; creditNotes: number | null };
}) {
  const [open, setOpen] = useState(false);
  const cell = (value: number | null) =>
    cn(
      "whitespace-nowrap text-right tabular-nums",
      value !== null && value < 0 && "text-destructive",
    );
  return (
    <>
      <TableRow data-financial-adjustment="credit-notes"
        className="border-t-2 border-destructive/30 bg-destructive/5 font-semibold text-destructive hover:bg-destructive/10">
        <TableCell colSpan={4} className="whitespace-nowrap py-3">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1.5 rounded-sm text-left focus-visible:outline focus-visible:outline-2"
          >
            <MinusCircle aria-hidden="true" className="h-4 w-4" /> Credit Notes (
            {adjustment.notes.length})
            <ChevronRight aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          </button>
        </TableCell>
        <TableCell
          className={cn(cell(adjustment.creditAmount), "py-3")}
          aria-label="Additional Credit Notes Total"
        >
          {adjustment.applied ? money(adjustment.creditAmount) : "—"}
        </TableCell>
        <TableCell
          className={cn(cell(adjustment.nbvAdjustment), "py-3")}
          aria-label="Credit Note NBV Adjustment"
        >
          {adjustment.applied ? money(adjustment.nbvAdjustment) : "—"}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/20 p-4">
            <p className="mb-2 text-xs text-muted-foreground">
              These credits have no product lines and have not been deducted in the product rows.
              Credit amounts excluding recorded GST are used once at dealer level.
              {adjustment.effectiveNbvRate !== null && (
                <>
                  {" "}
                  NBV adjustment rate:{" "}
                  {(adjustment.effectiveNbvRate * 100).toLocaleString("en-IN", {
                    maximumFractionDigits: 6,
                  })}
                  %.
                </>
              )}
            </p>
            {adjustment.reason && (
              <p className="mb-2 text-sm text-muted-foreground">{adjustment.reason}</p>
            )}
            {adjustment.notes.length ? (
              <dl className="space-y-2 text-sm">
                {adjustment.notes.map((note) => (
                  <div key={note.id} className="flex justify-between gap-4">
                    <dt>
                      {note.number || "Unnumbered credit note"} · {note.date} · {note.type} · excl. GST
                    </dt>
                    <dd className={cell(note.amount)}>{money(note.amount)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm">No additional credit notes in the saved selection.</p>
            )}
          </TableCell>
        </TableRow>
      )}
      <TableRow data-financial-adjustment="net-sales" className="border-t-2 bg-primary/10 font-bold hover:bg-primary/10">
        <TableCell className="whitespace-nowrap py-3">Net Sales</TableCell>
        {(["sales", "returns", "creditNotes"] as const).map((key) => (
          <TableCell key={key} className={cn(cell(productTotals?.[key] ?? null), "py-3")}
            aria-label={`Net Sales ${key === "creditNotes" ? "Credit Notes" : key === "returns" ? "Returns" : "Sales"} Total`}>
            {money(productTotals?.[key] ?? null)}
          </TableCell>
        ))}
        <TableCell className={cn(cell(adjustment.netSales), "py-3")} aria-label="Net Sales Total">
          {money(adjustment.netSales)}
        </TableCell>
        <TableCell className={cn(cell(adjustment.netNbv), "py-3")} aria-label="Net Sales NBV Total">
          {money(adjustment.netNbv)}
        </TableCell>
      </TableRow>
    </>
  );
}
