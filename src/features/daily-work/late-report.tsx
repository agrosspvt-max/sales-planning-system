"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDMY, formatDateTimeDMY } from "@/lib/date-format";
import { MAX_REASON_LENGTH, checkReason } from "@/lib/task-outcome";
import { useLabel } from "@/features/labels/label-ui";

export interface LateRequestView {
  id: string; workDate: string; deadline: string; reason: string; status: "PENDING" | "APPROVED" | "REJECTED" | "COMPLETED"; requestedAt: string;
  decidedByName: string | null; decidedAt: string | null; decisionReason: string | null;
}
export interface OutstandingReportView { date: string; deadline: string; requests: LateRequestView[]; canRequest: boolean }

/** The request's status as one short phrase (labels: Edit Labels). */
export function useLateStatusText(): (s: LateRequestView["status"]) => string {
  const t = { PENDING: useLabel("daily_work.late.status.PENDING"), APPROVED: useLabel("daily_work.late.status.APPROVED"), REJECTED: useLabel("daily_work.late.status.REJECTED"), COMPLETED: useLabel("daily_work.late.status.COMPLETED") };
  return (s) => t[s];
}

/** The dialog: the exact report date (read-only) and a required, meaningful reason. Nothing is sent until Submit. */
export function LateRequestDialog({ workDate, onClose, onSent }: { workDate: string; onClose: () => void; onSent: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const L = {
    title: useLabel("daily_work.late.dialog_title"), date: useLabel("daily_work.late.report_date"), reason: useLabel("daily_work.late.dialog_reason"), placeholder: useLabel("daily_work.late.dialog_reason_placeholder"),
    help: useLabel("daily_work.late.dialog_reason_help"), submit: useLabel("daily_work.late.dialog_submit"), cancel: useLabel("daily_work.late.dialog_cancel"),
    short: useLabel("daily_work.late.error.reason_short"), meaningless: useLabel("daily_work.late.error.reason_meaningless"), required: useLabel("daily_work.late.error.reason_required"),
  };
  const send = useMutation({
    mutationFn: () => api.post("/api/daily-work/late-report-requests", { workDate, reason }),
    onSuccess: () => onSent(),
    onError: (e) => setError((e as Error).message),
  });
  const check = reason.trim() === "" ? null : checkReason(reason);
  const problem = check === "reason_short" ? L.short : check === "reason_meaningless" ? L.meaningless : null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !send.isPending) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{L.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>{L.date}</Label><Input readOnly value={formatDMY(workDate)} aria-label={L.date} data-testid="late-request-date" /></div>
          <div className="space-y-1.5">
            <Label>{L.reason} *</Label>
            <Textarea rows={4} maxLength={MAX_REASON_LENGTH} value={reason} placeholder={L.placeholder} aria-label={L.reason} data-testid="late-request-reason" onChange={(e) => { setReason(e.target.value); setError(null); }} />
            <p className="text-xs text-muted-foreground">{L.help}</p>
            {problem && <p className="text-xs text-destructive">{problem}</p>}
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={send.isPending} onClick={onClose}>{L.cancel}</Button>
          <Button disabled={send.isPending || check !== "ok"} onClick={() => { if (check !== "ok") { setError(L.required); return; } send.mutate(); }}>{L.submit}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shown in both Daily Plan and Daily Report while a Sales Officer's earlier report is still outstanding: which report, its original deadline, why the plan is blocked, the request status / history
 * and the Request Late Report Submission button (hidden while a request is pending or approved). The plan itself stays blocked on the server whatever this panel shows.
 */
export function OutstandingReportPanel({ outstanding, onOpenReport, onChanged }: { outstanding: OutstandingReportView; onOpenReport?: () => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState(false);
  const qc = useQueryClient();
  const statusText = useLateStatusText();
  const L = {
    title: useLabel("daily_work.late.blocked_title"), date: useLabel("daily_work.late.report_date"), deadline: useLabel("daily_work.late.original_deadline"),
    request: useLabel("daily_work.late.request_button"), openReport: useLabel("daily_work.late.open_report"), sent: useLabel("daily_work.late.sent"), history: useLabel("daily_work.late.history"),
    requestedAt: useLabel("daily_work.late.requested_at"), decidedBy: useLabel("daily_work.late.decided_by"), rejection: useLabel("daily_work.late.rejection_reason"), readOnly: useLabel("daily_work.late.read_only_note"),
    approvedNote: useLabel("daily_work.late.approved_note"),
  };
  const [latest, ...older] = outstanding.requests;
  return (
    <div role="alert" className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" data-testid="outstanding-report">
      <div className="font-semibold">{L.title}</div>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">{L.date}</dt><dd className="font-medium tabular-nums" data-testid="outstanding-date">{formatDMY(outstanding.date)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{L.deadline}</dt><dd className="font-medium tabular-nums" data-testid="outstanding-deadline">{formatDateTimeDMY(outstanding.deadline)}</dd></div>
      </dl>
      {latest && (
        <div className="space-y-1 rounded-md border bg-background p-3" data-testid="late-request-status">
          <div className="flex flex-wrap items-center gap-2"><Badge variant={latest.status === "APPROVED" ? "success" : latest.status === "REJECTED" ? "destructive" : "secondary"}>{statusText(latest.status)}</Badge><span className="text-xs text-muted-foreground">{L.requestedAt.replace("{when}", formatDateTimeDMY(latest.requestedAt))}</span></div>
          <p className="whitespace-pre-wrap">{latest.reason}</p>
          {latest.decidedByName && <p className="text-xs text-muted-foreground">{L.decidedBy.replace("{name}", latest.decidedByName).replace("{when}", formatDateTimeDMY(latest.decidedAt))}</p>}
          {latest.decisionReason && <p className="text-xs text-destructive">{L.rejection.replace("{text}", latest.decisionReason)}</p>}
          {latest.status === "APPROVED" ? <p className="text-xs text-muted-foreground">{L.approvedNote}</p> : <p className="text-xs text-muted-foreground">{L.readOnly}</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {outstanding.canRequest && <Button size="sm" onClick={() => { setNotice(false); setOpen(true); }} data-testid="request-late-report">{L.request}</Button>}
        {onOpenReport && <Button size="sm" variant="outline" onClick={onOpenReport}>{L.openReport}</Button>}
        {notice && <span className="text-xs text-success">{L.sent}</span>}
      </div>
      {older.length > 0 && (
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{L.history}</summary>
          <ul className="mt-1 space-y-1">{older.map((r) => <li key={r.id}>{statusText(r.status)} · {formatDateTimeDMY(r.requestedAt)} — {r.reason}{r.decisionReason ? ` (${r.decisionReason})` : ""}</li>)}</ul>
        </details>
      )}
      {open && <LateRequestDialog workDate={outstanding.date} onClose={() => setOpen(false)} onSent={() => { setOpen(false); setNotice(true); qc.invalidateQueries({ queryKey: ["daily-work-status"] }); onChanged(); }} />}
    </div>
  );
}
