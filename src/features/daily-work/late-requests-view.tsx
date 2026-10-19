"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDMY, formatDateTimeDMY } from "@/lib/date-format";
import { useLabel } from "@/features/labels/label-ui";
import { useLateStatusText } from "./late-report";
import { useAdminPermission } from "@/features/accounts/permission-ui";

interface LateRequestRow {
  id: string; officerId: string; officerName: string; territory: string | null; state: string | null; workDate: string; deadline: string; reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "COMPLETED"; requestedAt: string; decidedByName: string | null; decidedByRole: string | null; decidedAt: string | null; decisionReason: string | null; completedAt: string | null;
}

/**
 * Performance → Requests (RM / authorized admin). Pending requests by default, history one click away. Fetched only while this view is open. The server decides who may see and decide
 * each request (an RM: their team's Sales Officers; an admin: through their stored permissions) — this screen only renders what it is given.
 */
export function LateRequestsView({ active = true }: { active?: boolean }) {
  const qc = useQueryClient();
  const canDecide = useAdminPermission("performance", "lateReports");
  const [view, setView] = useState<"pending" | "history">("pending");
  const [rejecting, setRejecting] = useState<LateRequestRow | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const statusText = useLateStatusText();
  const L = {
    pending: useLabel("daily_work.requests.pending"), history: useLabel("daily_work.requests.history"), officer: useLabel("daily_work.requests.col.officer"), workDate: useLabel("daily_work.requests.col.work_date"),
    deadline: useLabel("daily_work.requests.col.deadline"), reason: useLabel("daily_work.requests.col.reason"), requestedAt: useLabel("daily_work.requests.col.requested_at"), status: useLabel("daily_work.requests.col.status"),
    decision: useLabel("daily_work.requests.col.decision"), action: useLabel("daily_work.requests.col.action"), approve: useLabel("daily_work.requests.approve"), reject: useLabel("daily_work.requests.reject"),
    empty: useLabel("daily_work.requests.empty"), emptyHistory: useLabel("daily_work.requests.empty_history"), failed: useLabel("daily_work.requests.failed"), decidedBy: useLabel("daily_work.requests.decided_by"),
    rejectTitle: useLabel("daily_work.requests.reject_title"), rejectReason: useLabel("daily_work.requests.reject_reason"), rejectPlaceholder: useLabel("daily_work.requests.reject_placeholder"), cancel: useLabel("daily_work.late.dialog_cancel"),
    confirmReject: useLabel("daily_work.requests.confirm_reject"), rejectedWhy: useLabel("daily_work.late.rejection_reason"),
  };
  const { data, isLoading, isError } = useQuery<LateRequestRow[]>({ queryKey: ["late-report-requests", view], queryFn: () => api.get<LateRequestRow[]>(`/api/daily-work/late-report-requests?view=${view}`), enabled: active });
  const decide = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject"; reason?: string }) => api.post(`/api/daily-work/late-report-requests/${v.id}/decide`, { action: v.action, reason: v.reason }),
    onSuccess: () => { setRejecting(null); setNote(""); setError(null); qc.invalidateQueries({ queryKey: ["late-report-requests"] }); qc.invalidateQueries({ queryKey: ["performance"] }); },
    // e.g. "already decided": show it and refresh, so the list is current.
    onError: (e) => { setError((e as Error).message); qc.invalidateQueries({ queryKey: ["late-report-requests"] }); },
  });
  const rows = data ?? [];
  const showActions = view === "pending" && canDecide;
  const colCount = view === "history" || showActions ? 7 : 6;
  return (
    <div className="space-y-3" data-testid="late-requests">
      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
        {([["pending", L.pending], ["history", L.history]] as const).map(([v, label]) => (
          <button key={v} type="button" aria-pressed={view === v} onClick={() => { setView(v); setError(null); }}
            className={`rounded px-3 py-1.5 font-medium ${view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{L.officer}</TableHead><TableHead>{L.workDate}</TableHead><TableHead>{L.deadline}</TableHead><TableHead>{L.reason}</TableHead><TableHead>{L.requestedAt}</TableHead><TableHead>{L.status}</TableHead>
            {view === "history" && <TableHead>{L.decision}</TableHead>}
            {showActions && <TableHead className="text-right">{L.action}</TableHead>}
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={colCount}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : isError ? <TableRow><TableCell colSpan={colCount} className="py-8 text-center text-destructive" role="alert">{L.failed}</TableCell></TableRow>
              : rows.length === 0 ? <TableRow><TableCell colSpan={colCount} className="py-8 text-center text-muted-foreground" data-testid="requests-empty">{view === "pending" ? L.empty : L.emptyHistory}</TableCell></TableRow>
              : rows.map((r) => (
                <TableRow key={r.id} data-request-id={r.id}>
                  <TableCell><div className="font-medium">{r.officerName}</div><div className="text-xs text-muted-foreground">{[r.territory, r.state].filter(Boolean).join(" · ")}</div></TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums" data-testid="request-work-date">{formatDMY(r.workDate)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{formatDateTimeDMY(r.deadline)}</TableCell>
                  <TableCell className="max-w-[22rem] whitespace-pre-wrap text-sm">{r.reason}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums" data-testid="request-requested-at">{formatDateTimeDMY(r.requestedAt)}</TableCell>
                  <TableCell><Badge variant={r.status === "REJECTED" ? "destructive" : r.status === "PENDING" ? "secondary" : "success"}>{statusText(r.status)}</Badge></TableCell>
                  {view === "history" && (
                    <TableCell className="text-xs text-muted-foreground">
                      {r.decidedByName && <div>{L.decidedBy.replace("{name}", r.decidedByName).replace("{when}", formatDateTimeDMY(r.decidedAt))}</div>}
                      {r.decisionReason && <div className="text-destructive">{L.rejectedWhy.replace("{text}", r.decisionReason)}</div>}
                    </TableCell>
                  )}
                  {showActions && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, action: "approve" })}><Check className="h-4 w-4" /> {L.approve}</Button>
                        <Button size="sm" variant="ghost" className="text-destructive" disabled={decide.isPending} onClick={() => { setError(null); setNote(""); setRejecting(r); }}><X className="h-4 w-4" /> {L.reject}</Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
      {rejecting && canDecide && active && (
        <Dialog open onOpenChange={(o) => { if (!o && !decide.isPending) setRejecting(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{L.rejectTitle}</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <div className="text-sm text-muted-foreground">{rejecting.officerName} · {formatDMY(rejecting.workDate)}</div>
              <label className="text-sm font-medium">{L.rejectReason} *</label>
              <Textarea rows={3} value={note} placeholder={L.rejectPlaceholder} onChange={(e) => setNote(e.target.value)} data-testid="reject-reason" />
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={decide.isPending} onClick={() => setRejecting(null)}>{L.cancel}</Button>
              <Button variant="destructive" disabled={decide.isPending || note.trim().length < 5} onClick={() => decide.mutate({ id: rejecting.id, action: "reject", reason: note })}>{L.confirmReject}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
