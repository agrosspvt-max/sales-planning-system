"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
const displayTime = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    : "Waiting for office PC";
const reasons: Record<string, string> = {
  LEDGER_UNAVAILABLE: "Ledger could not be read",
  BILLS_LEDGER_MISMATCH: "Bills and ledger balance differ",
  MULTIPLE_LIVE_LEDGERS_FOR_DEALER: "More than one ledger maps to this dealer",
};
const reasonText = (code: string) => reasons[code] ?? "Needs review";
export function TallySettings() {
  const [access, setAccess] = useState<{ agentId: string; token: string } | null>(null);
  const q = useQuery<{
    configured: boolean;
    enabled?: boolean;
    lastSeenAt?: string | null;
    lastPublishedAt?: string | null;
    lastError?: string | null;
    job?: {
      status: string;
      summary?: {
        updatedPlans?: number;
        updatedDealers?: number;
        held?: { name: string; reason: string }[];
      };
    } | null;
  }>({
    queryKey: ["tally-status"],
    queryFn: () => api.get("/api/tally/status"),
    refetchInterval: 30000,
  });
  const revoke = useMutation({
    mutationFn: () => api.del("/api/tally/setup"),
    onSuccess: () => {
      setAccess(null);
      q.refetch();
    },
  });
  const setup = useMutation({
    mutationFn: () => api.post<{ agentId: string; token: string }>("/api/tally/setup", {}),
    onSuccess: (r) => {
      setAccess(r);
      q.refetch();
    },
  });
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Tally connection</h1>
      <p>
        The office connector sends verified bill balances to current-month Recovery plans. Other
        plans and entered planning figures are preserved.
      </p>
      {q.error && <p role="alert">{q.error.message}</p>}
      {q.data?.configured && q.data.enabled ? (
        <div>
          <p>Connector configured</p>
          <Button variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            Disable connection
          </Button>
          <p>Last contact: {displayTime(q.data.lastSeenAt)}</p>
          <p>
            Last published:{" "}
            {q.data.lastPublishedAt ? displayTime(q.data.lastPublishedAt) : "No data published yet"}
          </p>
          <p>
            Sync:{" "}
            {q.data.job?.status === "COMPLETE"
              ? "Completed"
              : q.data.job?.status === "RUNNING"
                ? "Reading and checking Tally"
                : q.data.job?.status === "FAILED"
                  ? "Last update did not complete"
                  : "Waiting"}
          </p>
          {q.data.lastError && (
            <p role="alert">
              {q.data.lastError === "SOME_DEALERS_HELD_FOR_REVIEW"
                ? "Some dealers kept their previous balances and need review."
                : q.data.lastError === "NO_CURRENT_PLAN_ALIASES"
                  ? "No saved aliases were found for dealers in current active plans."
                  : "The last update needs attention. Check that Tally and the office connector are running."}
            </p>
          )}
        </div>
      ) : (
        <Button
          disabled={setup.isPending || q.isLoading || !!q.error}
          onClick={() => setup.mutate()}
        >
          Create connector access
        </Button>
      )}
      {q.data?.job?.summary?.held?.length ? (
        <div className="space-y-2">
          <h2 className="font-medium">Balances kept for review</h2>
          <ul>
            {q.data.job.summary.held.slice(0, 20).map((row) => (
              <li key={row.name}>
                {row.name}: {reasonText(row.reason)}
              </li>
            ))}
          </ul>
          {q.data.job.summary.held.length > 20 && (
            <p>And {q.data.job.summary.held.length - 20} more dealers.</p>
          )}
        </div>
      ) : null}
      {setup.error && <p role="alert">{setup.error.message}</p>}
      {access && (
        <div className="space-y-2 rounded border p-4">
          <p>
            This access key is shown once. Enter it only in the office connector&apos;s hidden credential
            prompt.
          </p>
          <label className="block">
            Connector ID
            <input className="block w-full border p-2" readOnly value={access.agentId} />
          </label>
          <label className="block">
            Access key
            <input className="block w-full border p-2" readOnly value={access.token} />
          </label>
          <Button variant="outline" onClick={() => setAccess(null)}>
            Hide access key
          </Button>
        </div>
      )}
    </div>
  );
}
