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
import { DaybookLedgerLayoutDetails } from "./daybook-ledger-layout-details";

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

function Evidence({ details, code }: { details: DaybookDiagnostics; code?: string }) {
  const voucher = details.voucher;
  const encoding = details.encoding;
  const layoutConflict =
    code === "DAYBOOK_LEDGER_LAYOUT_AMBIGUOUS" || voucher?.layoutResolution === "conflicting";
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
          ...(layoutConflict
            ? []
            : [
                ["Problem ledger", voucher.ledgerName],
                ["Problem amount (as returned)", voucher.amount],
                ["Debit/credit flag (IsDeemedPositive)", voucher.isDeemedPositive],
                ["Ledger line number", voucher.lineNumber],
                ["Party-ledger flag", voucher.isPartyLedger],
              ]),
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
      {layoutConflict && (
        <p className="text-sm">
          The connector could not select one consistent ledger section. This is a whole-voucher
          layout issue; no single ledger amount has been identified as wrong.
        </p>
      )}
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[13rem_1fr]">
        {fields.map(([label, content]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="whitespace-pre-wrap break-words font-medium">{value(content)}</dd>
          </div>
        ))}
      </dl>
      {voucher?.ledgerLayouts && <DaybookLedgerLayoutDetails voucher={voucher} />}
      {layoutConflict && !voucher?.ledgerLayouts && (
        <p className="text-sm">
          This older error saved only one ledger section. Install connector 1.6.7-test and refresh
          the month to compare both sections.
        </p>
      )}
      {details.layoutResponse && (
        <section
          className="space-y-2 rounded border p-3 text-sm"
          aria-label="Original ledger-layout response"
        >
          <h4 className="font-medium">Original response evidence</h4>
          <p>Response size: {details.layoutResponse.responseBytes} bytes</p>
          <p className="break-all">SHA-256: {details.layoutResponse.responseSha256}</p>
          {details.layoutResponse.captureStatus === "saved" ? (
            <p className="break-all">
              Unchanged response saved on the Tally PC: {details.layoutResponse.localResponseFile}
            </p>
          ) : (
            <p>
              {details.layoutResponse.captureStatus === "limit_reached"
                ? "The monthly limit of 20 layout evidence files was reached."
                : "The original response could not be saved on the Tally PC."}{" "}
              The bounded comparison above remains available.
            </p>
          )}
        </section>
      )}
      {encoding && (
        <section
          className="space-y-3 rounded border p-3"
          aria-label="Original response encoding evidence"
        >
          <h3 className="text-sm font-medium">Exact response-byte evidence</h3>
          <p className="text-sm">
            The UTF-8 decoder stopped at byte {encoding.byteOffset} (position{" "}
            {encoding.byteOffset + 1} when counting from 1). The original response remains rejected.
          </p>
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[13rem_1fr]">
            {(
              [
                ["Decoder reason", encoding.decodeReason],
                ["Rejected bytes (hex)", encoding.invalidBytesHex],
                ["XML field near the byte", encoding.fieldName],
                ["Encoding declared in XML", encoding.declaredEncoding],
                ["Response encoding marker", encoding.bom],
                ["Response size", `${encoding.responseBytes} bytes`],
                ["Original response file", encoding.localResponseFile],
                ["Response SHA-256", encoding.responseSha256],
              ] as [string, string | undefined][]
            ).map(([label, content]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all font-mono text-xs">{value(content)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            Surrounding text below is for diagnosis. Invalid bytes are displayed as escaped byte
            codes; no text substitution is used to import financial data.
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
            {encoding.contextText}
          </pre>
          <details className="text-xs">
            <summary className="cursor-pointer">
              Surrounding bytes in hex · starts at byte {encoding.contextStart}
            </summary>
            <pre className="mt-2 whitespace-pre-wrap break-all">{encoding.contextHex}</pre>
          </details>
          {encoding.metadataRecovered && (
            <p className="text-xs text-muted-foreground">
              Voucher metadata above was recovered from nearby XML byte boundaries for diagnosis.
              Confirm it against the original response file.
            </p>
          )}
          {encoding.isolationError && (
            <p className="text-xs text-muted-foreground">
              Narrowing the request to a smaller date range stopped with {encoding.isolationError}.
              The original response and byte evidence above were retained.
            </p>
          )}
          {encoding.captureStatus === "saved" && (
            <p className="text-xs text-muted-foreground">
              The original .bin file is on the Tally computer at the path above. Its bytes were
              preserved without editing.
            </p>
          )}
          {encoding.captureStatus === "save_failed" && (
            <p className="text-xs text-muted-foreground">
              The connector could not save the local response file. The byte evidence above was
              still recorded.
            </p>
          )}
          {encoding.captureStatus === "limit_reached" && (
            <p className="text-xs text-muted-foreground">
              The monthly limit of 20 local encoding captures was reached. Byte evidence was
              recorded without creating another file.
            </p>
          )}
        </section>
      )}
      {!voucher && (
        <p className="text-sm text-muted-foreground">
          No individual voucher was identified for this failure. The reading stage and date range
          above show where it stopped.
        </p>
      )}
      {voucher && !layoutConflict && (
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
          <Evidence details={diagnostics} code={code} />
        ) : review.length ? (
          <div className="space-y-4">
            {review.map((row) => (
              <section key={row.guid} className="space-y-3 rounded border p-3">
                <h3 className="text-sm font-medium">
                  {row.date} · {row.voucherType} · {row.voucherNumber || "Voucher without number"}
                </h3>
                <p className="text-sm">{row.reason}</p>
                {row.details ? (
                  <Evidence details={row.details} code={row.reason} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    This capture did not include the dealer and ledger details. Update the connector
                    to 1.6.4-test and refresh this month.
                  </p>
                )}
              </section>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This failed read did not send voucher details. Install connector 1.6.4-test and refresh
            this month to collect the error details. For a timeout, Tally may not have returned an
            individual voucher.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
