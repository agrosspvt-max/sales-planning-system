"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { LateRequestView, OutstandingReportView } from "./late-report";

/** Refresh only the small approval status while waiting, without polling the full Daily Work status or touching unsaved answers. */
export function useLateApprovalSync(outstanding: OutstandingReportView | null) {
  const qc = useQueryClient();
  const pending = outstanding?.requests[0]?.status === "PENDING" ? outstanding.requests[0] : null;
  const pendingId = pending?.id;
  const date = outstanding?.date;
  const { data } = useQuery<Pick<LateRequestView, "id" | "status"> | null>({
    queryKey: ["late-report-request-status", date],
    queryFn: () => api.get(`/api/daily-work/late-report-requests/status?date=${date}`),
    enabled: !!pending,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => pending && !(query.state.data?.id === pending.id && query.state.data.status !== "PENDING") ? 15_000 : false,
    refetchIntervalInBackground: false,
  });
  const decisionId = data?.id;
  const decisionStatus = data?.status;
  useEffect(() => {
    if (pendingId && decisionId === pendingId && decisionStatus !== "PENDING") {
      // Refresh both today's plan gate and the older report's lock; report form queries stay untouched.
      void qc.invalidateQueries({ queryKey: ["daily-work-status"] });
    }
  }, [pendingId, decisionId, decisionStatus, qc]);
}
