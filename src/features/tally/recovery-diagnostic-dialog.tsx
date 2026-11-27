"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { RecoveryDiagnostic } from "./recovery-diagnostic";

const money = (value: string | null | undefined) => {
  if (value == null) return "Not recorded";
  const paise = BigInt(value.replace(".", ""));
  const absolute = paise < 0n ? -paise : paise;
  return `${paise < 0n ? "-" : ""}₹${(absolute / 100n).toLocaleString("en-IN")}.${String(absolute % 100n).padStart(2, "0")}`;
};
const time = (value: string) =>
  new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
export function RecoveryDiagnosticBody({ data }: { data: RecoveryDiagnostic }) {
  const evidence = data.evidence;
  return (
    <div className="space-y-4 text-sm">
      <p>{data.ledgerName}</p>
      <p className="text-xs text-muted-foreground">
        Cutoff: {data.asOf} · Recovery read: {time(data.recoveryCapturedAt)}
      </p>
      <p className="font-medium">
        {data.reason === "VERIFIED"
          ? "Accepted in this Recovery read"
          : data.reason === "BILLS_LEDGER_MISMATCH"
            ? "Open bills and ledger closing balance differ"
            : "Recovery balance needs review"}
      </p>
      {evidence && (
        <dl className="grid gap-3 rounded border bg-muted/20 p-3 sm:grid-cols-3">
          {[
            ["Ledger closing outstanding", evidence.closingOutstanding],
            ["Recovery pending-bill total", evidence.pendingTotal],
            ["Difference: closing minus bills", evidence.difference],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-semibold tabular-nums">{money(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="space-y-2 rounded border p-3" role="status">
        {data.messages.map((message) => (
          <p key={message}>{message}</p>
        ))}
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">
            Saved Daybook movement, excluding opening balance
          </dt>
          <dd className="font-medium">{money(data.daybook.movement)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Net On Account movement</dt>
          <dd className="font-medium text-warning">{money(data.daybook.onAccount)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        All amounts in this check include recorded GST and rounding. Positive movement increases
        receivables; negative movement reduces them. These are separate saved reads; refresh both if
        vouchers changed between them. Opening balances are not inferred.
      </p>
      <details>
        <summary className="cursor-pointer font-medium">
          Daybook coverage · {data.coverageComplete ? "covered through cutoff" : "incomplete"}
        </summary>
        <ul className="mt-2 space-y-1 text-xs">
          {data.coverage.map((row) => (
            <li key={row.month}>
              {row.month} · {row.complete ? "Complete" : "Needs refresh"} · through{" "}
              {row.throughDate ?? "not captured"}
              {row.capturedAt ? ` · saved ${time(row.capturedAt)}` : ""}
            </li>
          ))}
        </ul>
      </details>
      <section className="space-y-2" aria-label="Daybook evidence for Recovery">
        <h3 className="font-semibold">Vouchers and their bill adjustments</h3>
        {!data.daybook.vouchers.length && (
          <p>No saved Daybook vouchers were found for this ledger.</p>
        )}
        {data.daybook.vouchers.map((voucher) => (
          <details
            key={voucher.guid}
            className="rounded border"
            open={
              voucher.allocations.some((row) => /^on\s*account$/i.test(row.type)) ||
              !!voucher.issues.length
            }
          >
            <summary className="cursor-pointer p-3">
              <span className="font-medium">{voucher.number || "Unnumbered voucher"}</span> ·{" "}
              {voucher.date} · {voucher.type} · {money(voucher.movement)}
              {voucher.excluded && (
                <span className="ml-2 text-muted-foreground">Excluded: cancelled or optional</span>
              )}
              {voucher.allocations.some((row) => /^on\s*account$/i.test(row.type)) && (
                <span className="ml-2 font-medium text-warning">On Account</span>
              )}
            </summary>
            <div className="space-y-2 border-t p-3">
              {voucher.issues.map((issue) => (
                <p key={issue} className="text-warning">
                  {issue}
                </p>
              ))}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th className="p-2">Bill / reference</th>
                      <th className="p-2">Adjustment type</th>
                      <th className="p-2 text-right">Ledger movement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {voucher.allocations.map((row, index) => (
                      <tr key={index} className="border-t">
                        <td className="p-2">{row.reference ?? "No named bill"}</td>
                        <td className="p-2">{row.type}</td>
                        <td className="whitespace-nowrap p-2 text-right">{money(row.movement)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                Saved {time(voucher.capturedAt)} · Source voucher {voucher.guid}
              </p>
            </div>
          </details>
        ))}
      </section>
      {!!data.daybook.references.length && (
        <details>
          <summary className="cursor-pointer font-medium">
            Bill-reference comparison ({data.daybook.references.length})
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th className="p-2">Reference</th>
                  <th className="p-2 text-right">Daybook movement</th>
                  <th className="p-2 text-right">Recovery pending</th>
                  <th className="p-2 text-right">Difference</th>
                </tr>
              </thead>
              <tbody>
                {data.daybook.references.map((row) => (
                  <tr key={row.reference} className="border-t">
                    <td className="p-2">
                      {row.reference}
                      {row.openingReference && (
                        <p className="text-muted-foreground">
                          Original bill / opening reference not captured
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-2 text-right">{money(row.movement)}</td>
                    <td className="whitespace-nowrap p-2 text-right">
                      {money(row.recoveryPending)}
                    </td>
                    <td className="whitespace-nowrap p-2 text-right">
                      {row.difference === null ? "Cannot compare" : money(row.difference)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {evidence && (
        <details>
          <summary className="cursor-pointer font-medium">
            Original Recovery pending bills ({evidence.bills.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {evidence.bills.map((bill, index) => (
              <li key={index}>
                {bill.reference} · {bill.billDate} · due {bill.dueDate} ·{" "}
                {money(bill.pendingAmount)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        This check only reads saved evidence. It does not change bills, aliases, sales or Recovery
        balances.
      </p>
    </div>
  );
}

function DiagnosticContent({ ledgerName, jobId }: { ledgerName: string; jobId?: string }) {
  const query = useQuery<RecoveryDiagnostic>({
    queryKey: ["recovery-diagnostic", jobId ?? "latest", ledgerName],
    queryFn: () =>
      api.get(
        `/api/tally/recovery-diagnostic?${new URLSearchParams({ ledgerName, ...(jobId ? { jobId } : {}) })}`,
      ),
    staleTime: 0,
  });
  return (
    <>
      {query.isPending && <p role="status">Checking saved Recovery and Daybook evidence…</p>}
      {query.error && (
        <p role="alert">
          {query.error.message}{" "}
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </p>
      )}
      {query.data && <RecoveryDiagnosticBody data={query.data} />}
    </>
  );
}
export function RecoveryDiagnosticButton({
  ledgerName,
  jobId,
}: {
  ledgerName: string;
  jobId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0"
          aria-label={`Explain Recovery balance for ${ledgerName}`}
          title="Check Recovery against Daybook"
        >
          <Info aria-hidden="true" className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Recovery balance check</DialogTitle>
          <DialogDescription>
            Compare the ledger, pending bills and saved Daybook entries.
          </DialogDescription>
        </DialogHeader>
        {open && <DiagnosticContent ledgerName={ledgerName} jobId={jobId} />}
      </DialogContent>
    </Dialog>
  );
}
