"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";

import { DaybookErrorDetails } from "./daybook-error-details";
import { DaybookResultTables } from "./daybook-result-tables";
import { DaybookSalesComparisonDialog } from "./daybook-sales-comparison-dialog";
import { combineDaybookMonths } from "./daybook-range";
import {
  summaryDealerRows,
  type DaybookMonthStatus,
  type DaybookRangeStatus,
} from "./daybook-status";

const statusText: Record<string, string> = {
  QUEUED: "Waiting for the office connector.",
  RUNNING: "The office connector is reading Daybook.",
  SUCCEEDED: "Daybook refresh completed.",
  FAILED: "Daybook refresh failed. The last published figures are still in use.",
};
const errors: Record<string, string> = {
  DAYBOOK_LEDGER_LAYOUT_AMBIGUOUS:
    "Tally returned conflicting ledger sections. Open the info button to compare them; previously published figures are preserved.",
  LEASE_EXPIRED: "The office connector did not finish this request in time.",
  DAYBOOK_CAPTURE_REJECTED: "The capture failed validation.",
  DAYBOOK_SCOPE_CHANGED: "The capture did not cover the requested period. Request a fresh read.",
  DAYBOOK_VOUCHERS_NEED_REVIEW: "Some vouchers could not be classified safely.",
  SALES_FIELD_INVALID:
    "A voucher field was blank or too long. Install connector 1.6.1-test and refresh to identify the field.",
  DAYBOOK_GUID_INVALID: "Tally returned a voucher without a valid identity.",
  DAYBOOK_DATE_INVALID: "Tally returned a voucher without a valid date.",
  DAYBOOK_VOUCHERTYPENAME_INVALID: "A voucher type name was missing or too long.",
  DAYBOOK_PARTYLEDGERNAME_INVALID: "A party ledger name was invalid or too long.",
  DAYBOOK_VOUCHERNUMBER_INVALID: "A voucher number was invalid or too long.",
  DAYBOOK_LEDGERNAME_INVALID: "A ledger entry had an invalid or oversized name.",
  DAYBOOK_LEDGER_SIGN_MISMATCH:
    "A voucher ledger amount and debit/credit flag need checking. Open the info button for details.",
  SALES_ENCODING_REJECTED:
    "The Tally response contains bytes that cannot be read as UTF-8. Open the info button for byte evidence and the original response file.",
  TALLY_REQUEST_TIMEOUT: "Tally did not finish responding in time.",
  TALLY_UNAVAILABLE: "The connector could not read a response from Tally.",
  DAYBOOK_AMOUNT_INVALID: "A ledger entry had an invalid amount.",
  DAYBOOK_ISCANCELLED_INVALID: "Tally did not return a valid cancellation flag.",
  DAYBOOK_ISOPTIONAL_INVALID: "Tally did not return a valid optional-voucher flag.",
  DAYBOOK_ISDEEMEDPOSITIVE_INVALID: "Tally did not return the ledger entry direction.",
};

function MonthStatus({ entry, onView }: { entry: DaybookMonthStatus; onView?: () => void }) {
  const { job, published } = entry;
  const summary = published?.summary;
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">
        {entry.month} · {job ? statusText[job.status] : "No refresh requested yet."}
      </p>
      {published && (
        <p>
          Last published{" "}
          {new Date(published.completedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} ·
          vouchers through {published.throughDate}
        </p>
      )}
      {summary && (
        <>
          {!summary.dealerRows && (
            <p>
              Refresh this Daybook month to load the full dealer summary, including matched dealers.
            </p>
          )}
          <p>
            {summary.receiptCount} receipts · {summary.srCrCount} SR/CR vouchers ·{" "}
            {summary.matchedDealers} dealers verified · {summary.changedRows} Recovery rows changed
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <DaybookSalesComparisonDialog jobId={published!.id} />
            {onView && (
              <Button variant="outline" size="sm" onClick={onView}>
                View month
              </Button>
            )}
          </div>
        </>
      )}
      {job?.error && (
        <div className="flex items-center gap-3">
          <p>{errors[job.error] ?? job.error}</p>
          <DaybookErrorDetails
            month={entry.month}
            code={job.error}
            diagnostics={job.summary?.diagnostics}
            review={job.summary?.review}
          />
        </div>
      )}
      {!!job?.summary?.review?.length && (
        <details>
          <summary className="cursor-pointer">
            Vouchers to review ({job.summary.review.length})
          </summary>
          <ul className="ml-5 max-h-64 list-disc overflow-auto">
            {job.summary.review.map((v) => (
              <li key={v.guid}>
                {v.date} · {v.voucherType} {v.voucherNumber} · {v.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!summary?.dealerRows && !!summary?.recoveryIssues?.length && (
        <details>
          <summary className="cursor-pointer">
            Dealers without a unique Recovery plan ({summary.recoveryIssues.length})
          </summary>
          <ul className="ml-5 max-h-64 list-disc overflow-auto">
            {summary.recoveryIssues.map((row) => (
              <li key={row.dealerName}>
                {row.dealerName} · {row.issue}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!summary?.heldPrevious?.length && (
        <details>
          <summary className="cursor-pointer">Prior figures kept pending alias review</summary>
          <ul className="ml-5 max-h-64 list-disc overflow-auto">
            {summary.heldPrevious.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function TallyDaybookSync({ currentMonth }: { currentMonth: string }) {
  const lastMonth = currentMonth < "2027-03" ? currentMonth : "2027-03";
  const [fromMonth, setFromMonth] = useState(lastMonth);
  const [toMonth, setToMonth] = useState(lastMonth);
  const validMonth = (value: string) =>
    /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= "2026-04" && value <= lastMonth;
  const valid = validMonth(fromMonth) && validMonth(toMonth) && fromMonth <= toMonth;
  const single = fromMonth === toMonth;
  const status = useQuery({
    queryKey: ["tally-daybook-sync", fromMonth, toMonth],
    queryFn: () =>
      api.get<DaybookRangeStatus>(
        `/api/tally/daybook-sync?${new URLSearchParams({ fromMonth, toMonth })}`,
      ),
    enabled: valid,
    refetchInterval: single ? 5000 : 15000,
  });
  const refresh = useMutation({
    mutationFn: () => api.post("/api/tally/daybook-sync", { fromMonth, toMonth }),
    onSuccess: () => void status.refetch(),
  });
  const entries = status.data?.months ?? [];
  const combined = combineDaybookMonths(entries);
  const busy = entries.some((entry) => ["QUEUED", "RUNNING"].includes(entry.job?.status ?? ""));
  const publication = single ? entries[0]?.published : null;
  return (
    <section className="space-y-3 rounded border p-4">
      <h2 className="font-medium">Daybook sync</h2>
      <p className="text-sm text-muted-foreground">
        Select one month or a month range. Current-month data refreshes every 15 minutes while the
        office connector is running; selected months are refreshed one at a time on request.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          From month
          <input
            type="month"
            className="rounded border bg-background p-2"
            min="2026-04"
            max={lastMonth}
            value={fromMonth}
            onChange={(event) => setFromMonth(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          To month
          <input
            type="month"
            className="rounded border bg-background p-2"
            min={fromMonth || "2026-04"}
            max={lastMonth}
            value={toMonth}
            onChange={(event) => setToMonth(event.target.value)}
          />
        </label>
        <Button
          variant="outline"
          disabled={!valid || !status.data?.configured || refresh.isPending || (single && busy)}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending
            ? "Requesting refresh…"
            : single
              ? "Refresh Daybook from Tally"
              : "Refresh selected months"}
        </Button>
      </div>
      {!valid && (
        <p role="alert" className="text-sm">
          Choose a valid From/To month range from April 2026 to the current approved month.
        </p>
      )}
      {status.error && <p role="alert">{status.error.message}</p>}
      {refresh.error && <p role="alert">{refresh.error.message}</p>}
      <p role="status" className="text-sm">
        {status.data?.configured === false
          ? "Configure the office connector below."
          : valid && status.isPending
            ? "Loading saved Daybook data…"
            : busy
              ? "The office connector will process the queued months one at a time. Saved data remains visible."
              : status.isSuccess && !combined.savedMonths
                ? "No saved Daybook data for the selected period."
                : ""}
      </p>
      {valid && status.data?.configured && combined.missingMonths.length > 0 && (
        <p className="text-sm">
          No saved data for {combined.missingMonths.join(", ")}. Refresh the selected months to
          capture them; period totals remain unavailable until the missing data is present.
        </p>
      )}
      {single && entries[0] && <MonthStatus entry={entries[0]} />}
      {!single && !!entries.length && (
        <details className="rounded border p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Month status and comparisons ({entries.length})
          </summary>
          <div className="mt-3 space-y-3">
            {entries.map((entry) => (
              <div key={entry.month} className="rounded border p-3">
                <MonthStatus
                  entry={entry}
                  onView={() => {
                    setFromMonth(entry.month);
                    setToMonth(entry.month);
                  }}
                />
              </div>
            ))}
          </div>
        </details>
      )}
      {!!combined.savedMonths && (
        <div className="space-y-3 text-sm">
          {!single && (
            <p>
              {fromMonth} to {toMonth} · {combined.savedMonths} of {entries.length} months have
              saved data · {combined.voucherCount} voucher records
            </p>
          )}
          {combined.repeatedVouchers > 0 && (
            <p>
              {combined.repeatedVouchers} voucher IDs appeared in multiple months. Each is shown
              once using its latest published capture. Use View month to inspect earlier monthly
              captures.
            </p>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer">ⓘ Data sources</summary>
            <p className="mt-2">
              Bill products come from the original Daybook month for each voucher. Territory Plan
              continues using the existing Sales collection. Comparisons remain available separately
              for each captured month.
            </p>
          </details>
          <DaybookResultTables
            dealerRows={publication ? summaryDealerRows(publication.summary) : []}
            excludedVouchers={publication?.summary.excludedVouchers}
            coverage={publication?.summary.coverage ?? combined.coverage}
            sourceJobId={publication?.id}
            billHeaders={publication?.summary.billHeaders ?? combined.billHeaders}
            preparedView={single ? undefined : combined.view}
          />
        </div>
      )}
    </section>
  );
}
