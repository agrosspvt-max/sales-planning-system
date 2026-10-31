"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
type Summary = {
  updatedRows: number;
  changedRows: number;
  voucherCount: number;
  productLines: number;
  unallocatedCredits: number;
  changes?: {
    dealer: string;
    product: string;
    beforeQty: string;
    quantity: string;
    beforeAmount: string;
    amount: string;
  }[];
  held?: { name: string; reason: string; details: string[] }[];
};
type Status = {
  configured: boolean;
  job?: { id: string; status: string; error: string | null; summary: Summary | null };
  snapshot?: { observedAt: string; throughDate: string; summary: Summary } | null;
};
const reasons: Record<string, string> = {
  ALIAS_AMBIGUOUS: "Dealer alias matches more than one dealer",
  LEDGER_NOT_VERIFIED: "Dealer ledger was not verified in Tally",
  PRODUCT_NOT_UNIQUELY_MAPPED: "Product name needs mapping",
  PRODUCT_UNIT_CONFLICT: "Product units differ",
  PRODUCT_TOTAL_TOO_LARGE: "Product total needs review",
};
export function TallySalesRefresh({
  monthKey,
  chooseMonth = false,
}: {
  monthKey?: string;
  chooseMonth?: boolean;
}) {
  const [chosen, setChosen] = useState(
    monthKey ?? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7),
  );
  const month = monthKey ?? chosen,
    qc = useQueryClient(),
    last = useRef<string | null>(null),
    [details, setDetails] = useState(false);
  const q = useQuery<Status>({
    queryKey: ["tally-sales-status", month],
    queryFn: () => api.get("/api/tally/sales-status?month=" + encodeURIComponent(month)),
    refetchInterval: 10000,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () => api.post("/api/tally/sales-refresh", { monthKey: month }),
    onSuccess: () => void q.refetch(),
  });
  useEffect(() => {
    const stamp = q.data?.snapshot?.observedAt;
    if (stamp && last.current && stamp !== last.current) {
      void qc.invalidateQueries({ queryKey: ["monthly-plan"] });
      void qc.invalidateQueries({ queryKey: ["group-product-plan"] });
    }
    if (stamp) last.current = stamp;
  }, [q.data?.snapshot?.observedAt, qc]);
  if (q.error)
    return chooseMonth ? (
      <p className="text-sm text-muted-foreground">
        Sales sync is not enabled for this test website yet.
      </p>
    ) : null;
  const job = q.data?.job,
    summary = q.data?.snapshot?.summary;
  return (
    <div className="my-3 space-y-2 rounded border p-3">
      {chooseMonth && (
        <label>
          Sales month{" "}
          <input
            aria-label="Sales month"
            type="month"
            min="2026-04"
            max="2027-03"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
            className="ml-2 rounded border bg-background p-1"
          />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          disabled={
            !q.data?.configured ||
            refresh.isPending ||
            job?.status === "RUNNING" ||
            job?.status === "QUEUED"
          }
          onClick={() => refresh.mutate()}
        >
          Refresh sales from Tally
        </Button>
        <Button
          variant="outline"
          aria-label="Sales refresh details"
          aria-expanded={details}
          title="See changed sales and dealer issues"
          onClick={() => setDetails(!details)}
        >
          ⓘ
        </Button>
        <span className="text-sm">
          {job?.status === "QUEUED"
            ? "Waiting for the office connector."
            : job?.status === "RUNNING"
              ? "Reading sales from Tally…"
              : job?.status === "FAILED"
                ? "Sales refresh needs attention: " + job.error
                : summary
                  ? "Sales refreshed. " + summary.changedRows + " product rows changed."
                  : "No sales snapshot received yet."}
        </span>
      </div>
      {refresh.error && <p role="alert">{refresh.error.message}</p>}
      {q.data?.snapshot && (
        <p className="text-sm text-muted-foreground">
          Sales read{" "}
          {new Date(q.data.snapshot.observedAt).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          })}
          ; bills through {q.data.snapshot.throughDate}. Current month refreshes every 15 minutes
          while the office connector is running. Older months refresh on request.
        </p>
      )}
      {details && summary && (
        <div className="space-y-2 text-sm">
          <p>
            {summary.voucherCount} bills · {summary.productLines} product lines ·{" "}
            {summary.changedRows} changed rows.
          </p>
          <p>
            {summary.unallocatedCredits} financial notes without products were retained separately.
          </p>
          {(summary.changes?.length ?? 0) > 0 && (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th>Dealer / Product</th>
                    <th>Previous qty → New qty</th>
                    <th>Previous amount → New amount</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.changes?.map((change, index) => (
                    <tr key={index}>
                      <td className="py-2">
                        {change.dealer}
                        <br />
                        {change.product}
                      </td>
                      <td>
                        {change.beforeQty} → {change.quantity}
                      </td>
                      <td>
                        ₹
                        {Number(change.beforeAmount).toLocaleString("en-IN", {
                          maximumFractionDigits: 2,
                        })}{" "}
                        → ₹
                        {Number(change.amount).toLocaleString("en-IN", {
                          maximumFractionDigits: 2,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {summary.changedRows > (summary.changes?.length ?? 0) && (
                <p>Showing the first {summary.changes?.length} changed product rows.</p>
              )}
            </div>
          )}
          {summary.changedRows === 0 && (
            <p>No actual sales quantities or amounts changed in this refresh.</p>
          )}
          {summary.held?.map((h) => (
            <div key={h.name}>
              <strong>{h.name}</strong>: {reasons[h.reason] ?? h.reason}. Previous actuals kept.
              <ul>
                {h.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
