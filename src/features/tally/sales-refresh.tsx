"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiRequestError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { salesMonths } from "./sales-range";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const retryStatus = (count: number, error: Error) =>
  count < 2 && (!(error instanceof ApiRequestError) || error.status >= 500 || error.status === 429);
type Summary = {
  updatedRows: number;
  changedRows: number;
  voucherCount: number;
  productLines: number;
  unallocatedCredits: number;
  noEligiblePlans?: boolean;
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
function SalesMonthRefresh({
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
    retry: retryStatus,
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
                : job?.summary?.noEligiblePlans
                  ? "No eligible approved sales plans for this month."
                  : summary
                    ? "Sales refreshed. " + summary.changedRows + " product rows changed."
                    : "No sales snapshot received yet."}
        </span>
      </div>
      {q.error && (
        <p role="alert" className="text-sm">
          {q.error instanceof ApiRequestError &&
          q.error.message === "Tally sales synchronization is not enabled"
            ? "Sales sync is disabled for this website."
            : "Could not check sales status. Retrying automatically; your saved sales remain available."}
        </p>
      )}
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

type RangeStatus = {
  configured: boolean;
  lastSeenAt?: string | null;
  months: {
    monthKey: string;
    observedAt: string | null;
    job: {
      status: string;
      error: string | null;
      leaseExpiresAt: string | null;
      noEligiblePlans?: boolean;
    } | null;
  }[];
};
function SalesRangeRefresh() {
  const current = today().slice(0, 7),
    max = current < "2027-03" ? current : "2027-03";
  const [fromMonth, setFrom] = useState(max),
    [toMonth, setTo] = useState(max);
  const [selected, setSelected] = useState(max);
  let months: string[] = [],
    validation = "";
  try {
    months = salesMonths(fromMonth, toMonth, today());
  } catch (error) {
    validation = (error as Error).message;
  }
  const qc = useQueryClient();
  const q = useQuery<RangeStatus>({
    queryKey: ["tally-sales-range", fromMonth, toMonth],
    enabled: !validation,
    queryFn: () =>
      api.get("/api/tally/sales-status?fromMonth=" + fromMonth + "&toMonth=" + toMonth),
    refetchInterval: 10000,
    retry: retryStatus,
  });
  const refresh = useMutation({
    mutationFn: () =>
      api.post<{ jobs: { monthKey: string }[] }>("/api/tally/sales-refresh", {
        fromMonth,
        toMonth,
      }),
    onSuccess: () => {
      void q.refetch();
      void qc.invalidateQueries({ queryKey: ["tally-sales-status"] });
    },
  });
  const status = (row: RangeStatus["months"][number]) => {
    if (row.job?.status === "RUNNING")
      return row.job.leaseExpiresAt && Date.parse(row.job.leaseExpiresAt) < Date.now()
        ? "Read expired; waiting for connector recovery"
        : "Reading and saving sales";
    if (row.job?.status === "QUEUED") return "Queued for office connector";
    if (row.job?.status === "FAILED") return "Needs attention: " + row.job.error;
    if (row.job?.status === "SUCCEEDED")
      return row.job.noEligiblePlans ? "No eligible approved sales plans" : "Completed";
    return "No refresh requested";
  };
  const allQueued =
    !!q.data?.months.length &&
    q.data.months.every((r) => ["QUEUED", "RUNNING"].includes(r.job?.status ?? ""));
  return (
    <div className="my-3 space-y-3 rounded border p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label>
          From month{" "}
          <input
            aria-label="Sales from month"
            type="month"
            min="2026-04"
            max={max}
            value={fromMonth}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border bg-background p-1"
          />
        </label>
        <label>
          To month{" "}
          <input
            aria-label="Sales to month"
            type="month"
            min="2026-04"
            max={max}
            value={toMonth}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border bg-background p-1"
          />
        </label>
        <Button
          variant="outline"
          disabled={!!validation || !q.data?.configured || refresh.isPending || allQueued}
          onClick={() => refresh.mutate()}
        >
          Refresh selected months
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Months are read one at a time. Current-month sales and aging still refresh every 15 minutes
        while the connector is running. Older months refresh only on request.
      </p>
      {validation && <p role="alert">{validation}</p>}
      {q.error && (
        <p role="alert">
          Sales status is temporarily unavailable. Retrying automatically; the month selectors and
          saved sales are kept.
        </p>
      )}
      {refresh.error && <p role="alert">{refresh.error.message}</p>}
      {refresh.isSuccess && (
        <p role="status">Selected months queued. Existing pending requests are reused.</p>
      )}
      {q.data?.lastSeenAt && Date.now() - Date.parse(q.data.lastSeenAt) > 120000 && (
        <p role="status">
          The office connector has not contacted recently. Keep its window open on the awake Tally
          computer.
        </p>
      )}
      {!validation && (
        <div className="overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>Month</th>
                <th>Refresh status</th>
                <th>Last sales read</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {months.map((monthKey) => {
                const row = q.data?.months.find((r) => r.monthKey === monthKey);
                return (
                  <tr key={monthKey}>
                    <td className="py-2">{monthKey}</td>
                    <td>{row ? status(row) : "Checking status…"}</td>
                    <td>
                      {row?.observedAt
                        ? new Date(row.observedAt).toLocaleString("en-IN", {
                            timeZone: "Asia/Kolkata",
                          })
                        : "—"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="underline"
                        aria-pressed={selected === monthKey}
                        onClick={() => setSelected(monthKey)}
                      >
                        View {monthKey}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm">
        Sales details for {months.includes(selected) ? selected : fromMonth}
      </p>
      {!validation && (
        <SalesMonthRefresh monthKey={months.includes(selected) ? selected : fromMonth} />
      )}
    </div>
  );
}
export function TallySalesRefresh(props: { monthKey?: string; chooseMonth?: boolean }) {
  return props.chooseMonth ? <SalesRangeRefresh /> : <SalesMonthRefresh {...props} />;
}
