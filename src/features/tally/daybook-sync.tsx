"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";

type LedgerAmounts = { ledgerName: string; liveRecovery: string; srCr: string };
type Summary = {
  changedRows?: number;
  matchedDealers?: number;
  receiptCount?: number;
  srCrCount?: number;
  unmatched?: (LedgerAmounts & { candidates: string[] })[];
  excludedAccounts?: LedgerAmounts[];
  recoveryIssues?: { dealerName: string; issue: string }[];
  heldPrevious?: string[];
  review?: {
    guid: string;
    date: string;
    voucherType: string;
    voucherNumber: string;
    reason: string;
  }[];
};
type Status = {
  configured: boolean;
  job: { status: string; error: string | null; summary: Summary | null } | null;
  published: { completedAt: string; throughDate: string; summary: Summary } | null;
};

const statusText: Record<string, string> = {
  QUEUED: "Waiting for the office connector.",
  RUNNING: "The office connector is reading Daybook.",
  SUCCEEDED: "Daybook refresh completed.",
  FAILED: "Daybook refresh failed. The last published figures are still in use.",
};
const errors: Record<string, string> = {
  LEASE_EXPIRED: "The office connector did not finish this request in time.",
  DAYBOOK_CAPTURE_REJECTED: "The capture failed validation.",
  DAYBOOK_SCOPE_CHANGED: "The capture did not cover the requested period. Request a fresh read.",
  DAYBOOK_VOUCHERS_NEED_REVIEW: "Some vouchers could not be classified safely.",
};

const money = (amount: string) =>
  Number(amount).toLocaleString("en-IN", { style: "currency", currency: "INR" });

export function TallyDaybookSync({ currentMonth }: { currentMonth: string }) {
  const lastMonth = currentMonth < "2027-03" ? currentMonth : "2027-03";
  const [month, setMonth] = useState(lastMonth);
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month >= "2026-04" && month <= lastMonth;
  const status = useQuery({
    queryKey: ["tally-daybook-sync", month],
    queryFn: () => api.get<Status>(`/api/tally/daybook-sync?month=${encodeURIComponent(month)}`),
    enabled: valid,
    refetchInterval: 5000,
  });
  const refresh = useMutation({
    mutationFn: (requested: string) => api.post("/api/tally/daybook-sync", { month: requested }),
    onSuccess: () => void status.refetch(),
  });
  const { configured, job, published } = status.data ?? {};
  const summary = published?.summary;
  const busy = job?.status === "QUEUED" || job?.status === "RUNNING";
  return (
    <section className="space-y-3 rounded border p-4">
      <h2 className="font-medium">Daybook sync</h2>
      <p className="text-sm text-muted-foreground">
        Current-month receipts, returns and credit notes refresh every 15 minutes while the office
        connector is running. Select an older month to refresh it on request.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          Daybook month
          <input
            type="month"
            className="rounded border bg-background p-2"
            min="2026-04"
            max={lastMonth}
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
        </label>
        <Button
          variant="outline"
          disabled={!valid || !configured || busy || refresh.isPending}
          onClick={() => refresh.mutate(month)}
        >
          Refresh Daybook from Tally
        </Button>
      </div>
      {status.error && <p role="alert">{status.error.message}</p>}
      {refresh.error && <p role="alert">{refresh.error.message}</p>}
      <p role="status" className="text-sm">
        {configured === false
          ? "Configure the office connector below."
          : job
            ? statusText[job.status]
            : status.isSuccess
              ? "No Daybook refresh for this month yet."
              : ""}
      </p>
      {job?.error && <p className="text-sm">{errors[job.error] ?? job.error}</p>}
      {!!job?.summary?.review?.length && (
        <details className="text-sm">
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
      {published && summary && (
        <div className="space-y-2 text-sm">
          <p>
            Last published{" "}
            {new Date(published.completedAt).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })}{" "}
            · vouchers through {published.throughDate}
          </p>
          <p>
            {summary.receiptCount} receipts · {summary.srCrCount} SR/CR vouchers ·{" "}
            {summary.matchedDealers} dealers verified · {summary.changedRows} Recovery rows changed
          </p>
          {!!summary.unmatched?.length && (
            <details>
              <summary className="cursor-pointer">
                Ledgers without a unique dealer match ({summary.unmatched.length})
              </summary>
              <ul className="ml-5 max-h-64 list-disc overflow-auto">
                {summary.unmatched.map((row) => (
                  <li key={row.ledgerName}>
                    {row.ledgerName} · Receipts {money(row.liveRecovery)} · SR/CR {money(row.srCr)}
                    {!!row.candidates.length && (
                      <> · Possible matches {row.candidates.join(", ")}</>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!summary.recoveryIssues?.length && (
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
          {!!summary.heldPrevious?.length && (
            <details>
              <summary className="cursor-pointer">Prior figures kept pending alias review</summary>
              <ul className="ml-5 max-h-64 list-disc overflow-auto">
                {summary.heldPrevious.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </details>
          )}
          {!!summary.excludedAccounts?.length && (
            <p>
              Accounting ledgers excluded from dealer figures:{" "}
              {summary.excludedAccounts.map((r) => r.ledgerName).join(", ")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
