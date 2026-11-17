"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DealerAuditStatus } from "./dealer-audit";

export function TallyDealerAudit() {
  const audit = useQuery({
    queryKey: ["tally-dealer-audit"],
    queryFn: () => api.get<DealerAuditStatus>("/api/tally/dealer-audit"),
    refetchInterval: 60_000,
  });
  const { configured, completedAt, failed, summary } = audit.data ?? {};
  return (
    <section
      className="space-y-3 rounded-lg border bg-card p-4"
      aria-labelledby="tally-dealer-audit-title"
    >
      <h2 id="tally-dealer-audit-title" className="text-base font-semibold">
        Unmatched Tally dealers
      </h2>
      <p className="text-sm text-muted-foreground">
        Refreshes daily from 2:00 pm IST while Tally and the office connector are running.
      </p>
      {audit.error && <p role="alert">{audit.error.message}</p>}
      {audit.isLoading && <p role="status">Loading dealer reconciliation…</p>}
      {configured === false && <p className="text-sm">Configure the office connector to start.</p>}
      {failed && (
        <p role="status" className="text-sm">
          The latest scan could not finish. The connector will retry.
        </p>
      )}
      {configured && !summary && !failed && (
        <p className="text-sm">Waiting for the first dealer scan.</p>
      )}
      {completedAt && (
        <p className="text-sm text-muted-foreground">
          Last successful scan{" "}
          {new Date(completedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST
        </p>
      )}
      {summary && (
        <>
          <p className="text-sm">
            {summary.scanned.toLocaleString("en-IN")} checked ·{" "}
            {summary.matched.toLocaleString("en-IN")} matched ·{" "}
            <strong>{summary.unmatched.length.toLocaleString("en-IN")} unmatched</strong>
          </p>
          {summary.unmatched.length ? (
            <div className="max-h-96 overflow-auto rounded-md border">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Tally dealer
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Tally group
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {summary.unmatched.map(({ name, groups }) => (
                    <tr key={name}>
                      <td className="px-3 py-2">{name}</td>
                      <td className="px-3 py-2 text-muted-foreground">{groups.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm">All Tally dealers matched.</p>
          )}
        </>
      )}
    </section>
  );
}
