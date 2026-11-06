"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import type { DaybookPreviewResult } from "./daybook-preview.server";

const formatMoney = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const money = (amount: string | number) => formatMoney.format(Number(amount));
const payment = (value: { date: string; amount: string | number } | null) =>
  value ? `${value.date.split("-").reverse().join("/")} · ${money(value.amount)}` : "—";

export function TallyDaybookReview() {
  const [file, setFile] = useState<File | null>(null);
  const review = useMutation({
    mutationFn: async (capture: File) => {
      let data: unknown;
      try {
        data = JSON.parse(await capture.text());
      } catch {
        throw new Error("Choose the JSON file produced by Capture-Daybook.");
      }
      return api.post<DaybookPreviewResult>("/api/tally/daybook-preview", data);
    },
  });
  const result = review.data;
  return (
    <section className="space-y-3 rounded border p-3">
      <h2 className="font-medium">Daybook review</h2>
      <p className="text-sm text-muted-foreground">
        Check a local Daybook capture against dealer aliases, Recovery plans and the Last Payment
        Report. This is a read-only preview.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept=".json,application/json"
          aria-label="Daybook capture file"
          disabled={review.isPending}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            review.reset();
          }}
        />
        <Button
          variant="outline"
          disabled={!file || review.isPending}
          onClick={() => {
            if (file) review.mutate(file);
          }}
        >
          {review.isPending ? "Checking Daybook…" : "Preview Daybook"}
        </Button>
      </div>
      {review.error && (
        <p role="alert" className="text-sm">
          {review.error.message}
        </p>
      )}
      {result && (
        <div className="space-y-3 text-sm">
          <p role="status">
            {result.month} through {result.throughDate}.{" "}
            {result.completeMonth
              ? "Complete period for this month."
              : "Partial period for comparison."}
          </p>
          <p>
            {result.totals.receiptCount} receipts · {money(result.totals.liveRecovery)}.{" "}
            {result.totals.srCrCount} sales returns and credit notes · {money(result.totals.srCr)}.{" "}
            {result.excluded} excluded vouchers.
          </p>
          <p>
            {result.dealers.length} matched dealers ·{" "}
            {result.dealers.filter((d) => d.recovery).length} with one eligible Recovery plan
            {" · "}
            {result.unmatched.length} ledgers to review
          </p>
          <div className="max-h-96 overflow-auto">
            <table className="w-full min-w-[64rem] text-left">
              <thead className="sticky top-0 bg-background">
                <tr>
                  {[
                    "Dealer and Tally ledger",
                    "Recovery plan",
                    "Live Recovery",
                    "SR/CR",
                    "Last Payment on file",
                    "Latest captured receipt",
                  ].map((label) => (
                    <th key={label} scope="col" className="border-b p-2">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.dealers.map((row) => (
                  <tr key={row.ledgers[0]} className="border-b align-top">
                    <td className="p-2">
                      <strong>{row.dealerName}</strong>
                      <br />
                      {row.ledgers.join(", ")}
                    </td>
                    <td className="p-2">
                      {row.recovery
                        ? `${row.recovery.season} · ${row.recovery.officer}`
                        : row.recoveryIssue}
                    </td>
                    <td className="p-2">
                      {row.recovery && <>{money(row.recovery.liveRecovery)} → </>}
                      {money(row.liveRecovery)}
                    </td>
                    <td className="p-2">
                      {row.recovery && <>{money(row.recovery.srCr)} → </>}
                      {money(row.srCr)}
                    </td>
                    <td className="p-2">{payment(row.lastPaymentOnFile)}</td>
                    <td className="p-2">{payment(row.latestReceipt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!result.unmatched.length && (
            <details>
              <summary className="cursor-pointer">
                Ledgers without a unique alias or exact match ({result.unmatched.length})
              </summary>
              <ul className="ml-5 list-disc">
                {result.unmatched.map((row) => (
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
          {!!result.review.length && (
            <details>
              <summary className="cursor-pointer">
                Vouchers to review ({result.review.length})
              </summary>
              <ul className="ml-5 list-disc">
                {result.review.map((v) => (
                  <li key={v.guid}>
                    {v.date} · {v.voucherType} {v.voucherNumber} · {v.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
