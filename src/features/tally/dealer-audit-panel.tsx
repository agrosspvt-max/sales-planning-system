"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { DealerAuditStatus } from "./dealer-audit";
import { exportMissingDealers } from "./dealer-audit-export";

export function TallyDealerAudit() {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const audit = useQuery({
    queryKey: ["tally-dealer-audit"],
    queryFn: () => api.get<DealerAuditStatus>("/api/tally/dealer-audit"),
    refetchInterval: 5_000,
  });
  const refresh = useMutation({
    mutationFn: () => api.post("/api/tally/dealer-audit", {}),
    onSuccess: () => {
      void audit.refetch();
    },
  });
  const { configured, completedAt, failed, summary, refreshState } = audit.data ?? {};
  async function exportDealers() {
    if (!summary?.unmatched.length || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportMissingDealers(summary, completedAt ?? null);
    } catch {
      setExportError("Could not export missing dealers. Please try again.");
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Refreshes daily from 2:00 pm IST while Tally and the office connector are running.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!configured || audit.isLoading || refresh.isPending || Boolean(refreshState)}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending || refreshState ? "Refresh requested" : "Refresh dealers from Tally"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={audit.isLoading || !summary?.unmatched.length || exporting}
          onClick={() => void exportDealers()}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {exporting ? "Exporting…" : "Export missing dealers"}
        </Button>
      </div>
      {exportError && <p role="alert">{exportError}</p>}
      {refreshState && (
        <p role="status" className="text-sm">
          {refreshState === "running"
            ? "Reading dealer ledgers from Tally…"
            : "Waiting for the office connector."}
        </p>
      )}
      {refresh.error && <p role="alert">{refresh.error.message}</p>}
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
    </div>
  );
}
