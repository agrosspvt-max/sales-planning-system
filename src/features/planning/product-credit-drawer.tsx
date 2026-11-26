"use client";
import { useState } from "react";
import { ArrowLeft, ChevronRight, MinusCircle } from "lucide-react";
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
import type { ProductCreditSummary } from "./product-credit-summary";
const money = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value.toLocaleString("en-IN", {
        style: "currency",
        currency: "INR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
export function ProductCreditDrawer({
  summary,
  periodLabel,
  onClose,
  trigger,
}: {
  summary: ProductCreditSummary;
  periodLabel: string;
  onClose: () => void;
  trigger: HTMLButtonElement | null;
}) {
  const [dealerId, setDealerId] = useState<string | null>(null);
  const dealers = summary.dealers
    .filter(
      (dealer) =>
        dealer.creditAdjustment?.notes.length ||
        dealer.actualSalesAvailable === false ||
        dealer.actualNbvAvailable === false,
    )
    .sort(
      (a, b) =>
        (a.creditAdjustment?.creditAmount ?? 0) - (b.creditAdjustment?.creditAmount ?? 0) ||
        a.name.localeCompare(b.name),
    );
  const dealer = dealers.find((row) => row.dealerId === dealerId);
  const adjustment = dealer?.creditAdjustment;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="bottom-0 left-auto right-0 top-0 flex w-full max-w-3xl translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:rounded-none"
        onCloseAutoFocus={(event) => {
          if (trigger?.isConnected) {
            event.preventDefault();
            trigger.focus();
          }
        }}
      >
        <DialogHeader className="border-b p-4 pr-12">
          {dealer && (
            <button
              type="button"
              onClick={() => setDealerId(null)}
              className="mb-2 inline-flex w-fit items-center gap-1 text-sm text-primary"
            >
              <ArrowLeft className="h-4 w-4" /> All dealers
            </button>
          )}
          <DialogTitle className="flex items-center gap-2">
            <MinusCircle aria-hidden="true" className="h-5 w-5 text-destructive" />
            {dealer ? <DealerName id={dealer.dealerId} name={dealer.name} /> : "Credit Notes"}
          </DialogTitle>
          <DialogDescription>{periodLabel}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <p className="text-xs text-muted-foreground">
            Additional credit notes without product lines. Product-linked returns and credits remain
            in the product figures and are not deducted again. Recorded voucher totals include any
            recorded taxes.
          </p>
          <p className="text-xs text-muted-foreground">
            The total NBV adjustment uses the NBV proportion of the original sales totals.
            Dealer adjustments below use each dealer&apos;s own proportion and may not sum to that total.
          </p>
          {summary.reason && (
            <p className="rounded border p-3 text-sm text-muted-foreground">{summary.reason}</p>
          )}
          {dealer && adjustment ? (
            <>
              {adjustment.reason && (
                <p className="text-sm text-muted-foreground">{adjustment.reason}</p>
              )}
              <dl className="grid grid-cols-2 gap-3 rounded border bg-destructive/5 p-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Credit Notes</dt>
                  <dd className="font-semibold text-destructive">
                    {summary.applied ? money(adjustment.creditAmount) : "Not applied to category"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">NBV adjustment</dt>
                  <dd className="font-semibold text-destructive">
                    {summary.applied ? money(adjustment.nbvAdjustment) : "—"}
                  </dd>
                </div>
              </dl>
              {adjustment.effectiveNbvRate !== null && (
                <p className="text-xs text-muted-foreground">
                  Dealer NBV rate:{" "}
                  {(adjustment.effectiveNbvRate * 100).toLocaleString("en-IN", {
                    maximumFractionDigits: 6,
                  })}
                  % · NBV {money(dealer.nbvBeforeCredits)} ÷ sales{" "}
                  {money(dealer.salesBeforeCredits)} before these credits.
                </p>
              )}
              {adjustment.notes.map((note) => (
                <details key={note.id} className="rounded border">
                  <summary className="cursor-pointer p-3 text-sm">
                    <span className="font-semibold">{note.number || "Unnumbered credit note"}</span>
                    <span className="ml-2 text-muted-foreground">
                      {note.date} · {note.type}
                    </span>
                    <span className="ml-2 whitespace-nowrap font-semibold text-destructive">
                      {money(note.amount)}
                    </span>
                  </summary>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t p-3 text-sm">
                    <dt className="text-muted-foreground">Date</dt>
                    <dd>{note.date}</dd>
                    <dt className="text-muted-foreground">Voucher type</dt>
                    <dd>{note.type}</dd>
                    <dt className="text-muted-foreground">Month</dt>
                    <dd>{note.monthKey}</dd>
                    <dt className="text-muted-foreground">Recorded amount</dt>
                    <dd>{money(note.amount)}</dd>
                    <dt className="text-muted-foreground">Source reference</dt>
                    <dd className="break-all">{note.guid}</dd>
                  </dl>
                </details>
              ))}
              {!adjustment.notes.length && (
                <p className="text-sm text-muted-foreground">
                  No credit-note bills are available in the saved selection for this dealer.
                </p>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-wrap justify-between gap-3 rounded border bg-destructive/5 p-3 text-sm font-semibold">
                <span>
                  Credit Notes:{" "}
                  {summary.applied ? money(summary.creditAmount) : "Not applied to category"}
                </span>
                <span>NBV adjustment: {summary.applied ? money(summary.nbvAdjustment) : "—"}</span>
              </div>
              <Table aria-label="Credit Notes by dealer">
                <TableHeader>
                  <TableRow>
                    <TableHead>Dealer</TableHead>
                    <TableHead className="text-right">Notes</TableHead>
                    <TableHead className="text-right">Credit Notes</TableHead>
                    <TableHead className="text-right">NBV adjustment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dealers.map((row) => (
                    <TableRow key={row.dealerId}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setDealerId(row.dealerId)}
                          className="inline-flex items-center gap-1 text-left text-primary hover:underline"
                        >
                          <DealerName id={row.dealerId} name={row.name} />
                          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                        </button>
                      </TableCell>
                      <TableCell className="text-right">
                        {row.creditAdjustment?.notes.length ?? 0}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {summary.applied ? money(row.creditAdjustment?.creditAmount) : "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {summary.applied ? money(row.creditAdjustment?.nbvAdjustment) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!dealers.length && (
                <p className="text-sm text-muted-foreground">
                  No additional credit notes for the selected filters.
                </p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
