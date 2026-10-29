"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { OutstandingHistory } from "./changes";

const money = (value: string) =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(value),
  );
const time = (value: string) =>
  new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

export function TallyChangeHistory({ planId }: { planId: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery<OutstandingHistory>({
    queryKey: ["tally-outstanding-changes", planId],
    queryFn: () => api.get(`/api/tally/changes?planId=${encodeURIComponent(planId)}`),
    enabled: open,
    refetchInterval: open ? 10000 : false,
    staleTime: 0,
  });
  return (
    <>
      <Button
        variant="outline"
        size="icon"
        aria-label="Recent outstanding changes"
        title="Recent outstanding changes"
        onClick={() => setOpen(true)}
      >
        <Info className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Recent outstanding changes</DialogTitle>
            <DialogDescription>
              Only dealers whose Current Outstanding changed are listed. Records are for this plan.
            </DialogDescription>
          </DialogHeader>
          {query.isPending && <p role="status">Loading changes…</p>}
          {query.error && (
            <div role="alert">
              <p>{query.error.message}</p>
              <Button variant="outline" onClick={() => query.refetch()}>
                Try again
              </Button>
            </div>
          )}
          {query.data && (
            <>
              {query.data.latestRefresh?.changedCount != null && (
                <p className="text-sm text-muted-foreground">
                  Latest refresh: {time(query.data.latestRefresh.publishedAt)} —{" "}
                  {query.data.latestRefresh.changedCount === 0
                    ? "no outstanding balances changed."
                    : `${query.data.latestRefresh.changedCount} dealer balances changed.`}
                </p>
              )}
              {query.data.records.length === 0 ? (
                <p>
                  {query.data.latestRefresh?.changedCount == null
                    ? "Detailed change records will appear after the next successful Tally refresh."
                    : "No outstanding changes recorded yet."}
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[38rem] text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="p-2">Refreshed</th>
                          <th className="p-2">Dealer</th>
                          <th className="p-2 text-right">Previous outstanding</th>
                          <th className="p-2 text-right">New outstanding</th>
                        </tr>
                      </thead>
                      <tbody>
                        {query.data.records.map((row) => (
                          <tr key={row.id} className="border-b align-top">
                            <td className="whitespace-nowrap p-2">{time(row.publishedAt)}</td>
                            <td className="p-2">
                              <div>{row.dealerName}</div>
                              {row.reason === "UNAVAILABLE_ZERO" && (
                                <div className="text-xs text-muted-foreground">
                                  Set to zero under your unavailable-ledger rule
                                </div>
                              )}
                              {row.reason === "CREDIT_ADVANCE" && (
                                <div className="text-xs text-success">Credit / advance balance</div>
                              )}
                            </td>
                            <td
                              className={`p-2 text-right tabular-nums ${Number(row.before) < 0 ? "text-success" : ""}`}
                            >
                              {money(row.before)}
                            </td>
                            <td
                              className={`p-2 text-right font-medium tabular-nums ${Number(row.after) < 0 ? "text-success" : ""}`}
                            >
                              {money(row.after)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Showing up to {query.data.limit} recent changes, newest refresh first.
                  </p>
                </>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
