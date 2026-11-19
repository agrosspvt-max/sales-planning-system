"use client";

import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { DaybookDiagnostics } from "./daybook-diagnostics";

type Review = {
  guid: string;
  date: string;
  voucherNumber: string;
  voucherType: string;
  reason: string;
  details?: DaybookDiagnostics;
};
const value = (input: string | number | null | undefined) =>
  input == null || input === "" ? "Not returned by Tally" : String(input);
const stage: Record<string, string> = {
  vouchers: "Reading vouchers",
  company_check_before: "Checking the Tally company before reading",
  company_check_after: "Checking the Tally company after reading",
  collection: "Reading Daybook",
};

function Evidence({ details }: { details: DaybookDiagnostics }) {
  const voucher = details.voucher;
  const fields: [string, string | number | null | undefined][] = [
    ["Tally company", details.companyName],
    ["Reading stage", stage[details.stage] ?? details.stage],
    ["Requested dates", `${details.fromDate} to ${details.throughDate}`],
    ...(voucher
      ? ([
          ["Bill / voucher number", voucher.voucherNumber],
          ["Voucher date", voucher.date],
          ["Voucher type", voucher.voucherType],
          ["Dealer / party name", voucher.dealerName],
          ["Problem ledger", voucher.ledgerName],
          ["Problem amount (as returned)", voucher.amount],
          ["Debit/credit flag (IsDeemedPositive)", voucher.isDeemedPositive],
          ["Ledger line number", voucher.lineNumber],
          ["Party-ledger flag", voucher.isPartyLedger],
          ["Voucher GUID", voucher.guid],
          ["Tally master ID", voucher.masterId],
          ["Tally alteration ID", voucher.alterId],
          ["Cancelled", voucher.cancelled],
          ["Optional", voucher.optional],
          ["Narration", voucher.narration],
        ] as [string, string | number | null | undefined][])
      : []),
  ];
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[13rem_1fr]">
        {fields.map(([label, content]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="whitespace-pre-wrap break-words font-medium">{value(content)}</dd>
          </div>
        ))}
      </dl>
      {!voucher && (
        <p className="text-sm text-muted-foreground">
          No individual voucher was identified for this failure. The reading stage and date range
          above show where it stopped.
        </p>
      )}
      {voucher && (
        <>
          <h4 className="text-sm font-medium">
            Ledger entries in this voucher ({voucher.ledgerEntryCount})
          </h4>
          <p className="text-xs text-muted-foreground">
            Amounts and flags below are the original Tally values.{" "}
            {voucher.lineNumber
              ? `The problem is on ledger line ${voucher.lineNumber}, highlighted when listed below.`
              : "These entries show the available ledger candidates."}{" "}
            The normal parser expects No for a credit entry and Yes for a debit entry.
          </p>
          <div className="overflow-auto rounded border">
            <table className="w-full min-w-[38rem] text-left text-sm">
              <thead className="bg-muted">
                <tr>
                  {["Line", "Ledger", "Amount", "IsDeemedPositive", "IsPartyLedger"].map(
                    (label) => (
                      <th scope="col" key={label} className="p-2">
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {voucher.ledgerEntries.map((entry) => (
                  <tr
                    key={entry.lineNumber}
                    className={
                      entry.lineNumber === voucher.lineNumber
                        ? "border-t bg-destructive/10"
                        : "border-t"
                    }
                  >
                    <td className="p-2">
                      {entry.lineNumber}
                      {entry.lineNumber === voucher.lineNumber ? " · Issue" : ""}
                    </td>
                    <td className="p-2">{value(entry.ledgerName)}</td>
                    <td className="whitespace-nowrap p-2 tabular-nums">{value(entry.amount)}</td>
                    <td className="p-2">{value(entry.isDeemedPositive)}</td>
                    <td className="p-2">{value(entry.isPartyLedger)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {voucher.ledgerEntryCount > voucher.ledgerEntries.length && (
            <p className="text-xs text-muted-foreground">
              Showing the first {voucher.ledgerEntries.length} ledger entries. The problem ledger
              and amount are shown above.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function DaybookErrorDetails({
  month,
  code,
  diagnostics,
  review = [],
}: {
  month: string;
  code: string;
  diagnostics?: DaybookDiagnostics;
  review?: Review[];
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="View Daybook error details"
          title="View Daybook error details"
        >
          <Info className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Daybook error details · {month}</DialogTitle>
          <DialogDescription>
            The last successful website figures are preserved. Use the voucher details below to find
            the entry in Tally.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">{code}</p>
        {code === "DAYBOOK_LEDGER_SIGN_MISMATCH" && (
          <p className="text-sm">
            A ledger amount or debit/credit flag did not fit the connector’s parsing rule. This does
            not by itself prove that the Tally voucher is incorrect.
          </p>
        )}
        {diagnostics ? (
          <Evidence details={diagnostics} />
        ) : review.length ? (
          <div className="space-y-4">
            {review.map((row) => (
              <section key={row.guid} className="space-y-3 rounded border p-3">
                <h3 className="text-sm font-medium">
                  {row.date} · {row.voucherType} · {row.voucherNumber || "Voucher without number"}
                </h3>
                <p className="text-sm">{row.reason}</p>
                {row.details ? (
                  <Evidence details={row.details} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    This capture did not include the dealer and ledger details. Update the connector
                    to 1.6.3-test and refresh this month.
                  </p>
                )}
              </section>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This failed read did not send voucher details. Install connector 1.6.3-test and refresh
            this month to collect the error details. For a timeout, Tally may not have returned an
            individual voucher.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
