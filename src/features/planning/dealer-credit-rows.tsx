"use client";
import { useState } from "react";
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
export function DealerCreditRows({ adjustment }: { adjustment: DealerCreditAdjustment }) {
  const [open, setOpen] = useState(false);
  const cell = (value: number | null) =>
    cn(
      "whitespace-nowrap text-right tabular-nums",
      value !== null && value < 0 && "text-destructive",
    );
  return (
    <>
      <TableRow>
        <TableCell colSpan={3}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-2 text-left font-medium"
          >
            <span aria-hidden="true">{open ? "▼" : "▶"}</span> Credit Notes (
            {adjustment.notes.length})
          </button>
        </TableCell>
        <TableCell
          className={cell(adjustment.nbvAdjustment)}
          aria-label="Credit Note NBV Adjustment"
        >
          {adjustment.applied ? money(adjustment.nbvAdjustment) : "—"}
        </TableCell>
        <TableCell />
        <TableCell
          className={cell(adjustment.creditAmount)}
          aria-label="Additional Credit Notes Total"
        >
          {adjustment.applied ? money(adjustment.creditAmount) : "—"}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/20 p-4">
            <p className="mb-2 text-xs text-muted-foreground">
              These credits have no product lines and have not been deducted in the product rows.
              Recorded voucher totals, including any recorded taxes, are used once at dealer level.
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
                      {note.number || "Unnumbered credit note"} · {note.date} · {note.type}
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
      <TableRow className="bg-muted/40 font-semibold">
        <TableCell colSpan={3}>Net Sales</TableCell>
        <TableCell className={cell(adjustment.netNbv)} aria-label="Net Sales NBV Total">
          {money(adjustment.netNbv)}
        </TableCell>
        <TableCell />
        <TableCell className={cell(adjustment.netSales)} aria-label="Net Sales Total">
          {money(adjustment.netSales)}
        </TableCell>
      </TableRow>
    </>
  );
}
