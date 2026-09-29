"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { currentBusinessDate } from "@/lib/daily-work";
import { paymentStatusLabel, type CnPaymentStatusValue } from "@/lib/cn-request";
import { formatSchemeCurrency } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useLabel } from "@/features/labels/label-ui";

interface PaymentDetail {
  cnRequestId: string; partyName: string; cnType: string; details: string | null; cnStatus: string;
  paymentStatus: string | null; originalOutstandingAmount: number | null; currentOutstandingAmount: number | null;
  expiryDate: string | null; canUpdate: boolean; canVerify: boolean; paymentVerified: boolean; isAdmin: boolean; activeTaskId: string | null;
  events: Array<{ id: string; status: string; amountPaid: number | null; eventDate: string; outstandingBefore: number; outstandingAfter: number; source: string; recordedBy: string; createdAt: string }>;
  tasks: Array<{ id: string; eventId: string; amount: number; date: string | null; status: string; createdAt: string }>;
}

const money = (value: number | null) => value == null ? "—" : formatSchemeCurrency(value);
const displayDate = (value: string | null, notScheduled: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { dateStyle: "medium" }) : notScheduled;

// Who recorded an event, and whether it is authoritative. Admin verification is GREEN (authoritative);
// SO reports are GRAY (provisional); the acceptance/system baseline is neutral.
function eventSource(source: string, labels: Pick<PaymentLabels, "adminVerified" | "admin" | "soReported" | "system">): { label: string; variant: "success" | "muted" | "secondary" } {
  if (source === "ADMIN_VERIFY") return { label: labels.adminVerified, variant: "success" };
  if (source === "ADMIN_UPDATE" || source === "ADMIN_CORRECTION") return { label: labels.admin, variant: "success" };
  if (source === "SO_UPDATE") return { label: labels.soReported, variant: "muted" };
  return { label: labels.system, variant: "secondary" };
}

export function CnPaymentDialog({ requestId, onClose, onChanged }: { requestId: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<PaymentDetail>({ queryKey: ["cn-payment", requestId], queryFn: () => api.get(`/api/cn-requests/${requestId}/payment`) });
  const L = {
    title: useLabel("cn_requests.payment.title"), original: useLabel("cn_requests.payment.original_amount"),
    outstanding: useLabel("cn_requests.payment.outstanding_amount"), history: useLabel("cn_requests.payment.history"),
    tasks: useLabel("cn_requests.payment.recovery_tasks"), update: useLabel("cn_requests.payment.update"),
    verify: useLabel("cn_requests.payment.verify"),
    amountPaid: useLabel("cn_requests.payment.amount_paid"),
    paymentDate: useLabel("cn_requests.payment.payment_date"), followUpDate: useLabel("cn_requests.payment.follow_up_date"),
    paymentStatus: useLabel("cn_requests.field.payment_status"), close: useLabel("cn_requests.action.close"),
    pending: useLabel("cn_requests.payment.pending"), notPaid: useLabel("cn_requests.payment.not_paid"),
    partialPaid: useLabel("cn_requests.payment.partial_paid"), paid: useLabel("cn_requests.payment.paid"),
    selectStatus: useLabel("cn_requests.payment.select_status"), selectVerifiedStatus: useLabel("cn_requests.payment.select_verified_status"),
    saveStatus: useLabel("cn_requests.payment.save_status"), saving: useLabel("cn_requests.payment.saving"), verifying: useLabel("cn_requests.payment.verifying"),
    notScheduled: useLabel("cn_requests.payment.not_scheduled"), adminVerified: useLabel("cn_requests.payment.admin_verified"),
    admin: useLabel("cn_requests.payment.admin"), soReported: useLabel("cn_requests.payment.so_reported"), system: useLabel("cn_requests.payment.system"),
    paidSuffix: useLabel("cn_requests.payment.paid_suffix"), remainingSuffix: useLabel("cn_requests.payment.remaining_suffix"), recordedBy: useLabel("cn_requests.payment.recorded_by"),
    unavailable: useLabel("cn_requests.payment.unavailable"), verifyHelp: useLabel("cn_requests.payment.verify_help"),
    taskUnscheduled: useLabel("cn_requests.payment.task_unscheduled"), taskScheduled: useLabel("cn_requests.payment.task_scheduled"), taskCompleted: useLabel("cn_requests.payment.task_completed"),
  };

  const refresh = (next: PaymentDetail) => {
    qc.setQueryData(["cn-payment", requestId], next);
    qc.invalidateQueries({ queryKey: ["cn-tasks-pending"] });
    onChanged();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{L.title}{data ? ` — ${data.partyName}` : ""}</DialogTitle></DialogHeader>
        {isLoading ? <Skeleton className="h-64 w-full" /> : error || !data ? (
          <p className="text-sm text-destructive">{(error as Error | null)?.message ?? L.unavailable}</p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">{L.paymentStatus}</div>
                <Badge variant={data.paymentStatus == null || data.paymentStatus === "Pending" ? "secondary" : data.paymentVerified ? "success" : "muted"}>
                  {paymentStatusLabel(data.paymentStatus, L)}
                </Badge>
              </div>
              <div><div className="text-xs text-muted-foreground">{L.original}</div><div className="font-semibold tabular-nums">{money(data.originalOutstandingAmount)}</div></div>
              <div><div className="text-xs text-muted-foreground">{L.outstanding}</div><div className="font-semibold tabular-nums">{money(data.currentOutstandingAmount)}</div></div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold">{L.history}</h3>
              <div className="space-y-2">
                {data.events.map((event) => {
                  const src = eventSource(event.source, L);
                  return (
                    <div key={event.id} className="rounded border px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-2"><span className="font-medium">{paymentStatusLabel(event.status, L)}</span><Badge variant={src.variant}>{src.label}</Badge></span>
                        <span>{displayDate(event.eventDate, L.notScheduled)}</span>
                      </div>
                      {event.amountPaid != null && <div>{money(event.amountPaid)} {L.paidSuffix}</div>}
                      <div className="text-muted-foreground">{money(event.outstandingAfter)} {L.remainingSuffix} · {L.recordedBy} {event.recordedBy}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold">{L.tasks}</h3>
              <div className="space-y-2">
                {data.tasks.map((task) => <div key={task.id} className="flex flex-wrap justify-between gap-2 rounded border px-3 py-2 text-sm"><span>{money(task.amount)} · {displayDate(task.date, L.notScheduled)}</span><Badge variant={task.status === "COMPLETED" ? "muted" : "secondary"}>{task.status === "COMPLETED" ? L.taskCompleted : task.status === "SCHEDULED" ? L.taskScheduled : L.taskUnscheduled}</Badge></div>)}
              </div>
            </div>

            {/* SO reports what happened (provisional → gray). Only the owning SO on an active SCHEDULED task. */}
            {data.canUpdate && <SalesOfficerReportForm data={data} requestId={requestId} labels={L} onSaved={refresh} />}

            {/* Admin verifies / overrides (authoritative → green). No date fields; the SO schedules any new task. */}
            {data.canVerify && <AdminVerifyForm requestId={requestId} labels={L} onSaved={refresh} />}
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>{L.close}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type PaymentLabels = {
  update: string; verify: string; amountPaid: string; paymentDate: string; followUpDate: string;
  pending: string; notPaid: string; partialPaid: string; paid: string; selectStatus: string; selectVerifiedStatus: string;
  saveStatus: string; saving: string; verifying: string; adminVerified: string; admin: string; soReported: string; system: string;
  verifyHelp: string;
};

/** SO PAYMENT REPORT — provisional. Reports Paid / Partial Paid / Not Paid with dates on the active task. */
function SalesOfficerReportForm({ data, requestId, labels, onSaved }: { data: PaymentDetail; requestId: string; labels: PaymentLabels; onSaved: (next: PaymentDetail) => void }) {
  const [status, setStatus] = useState<CnPaymentStatusValue | "">("");
  const [amountPaid, setAmountPaid] = useState("");
  const [paymentDate, setPaymentDate] = useState(currentBusinessDate());
  const [followUpDate, setFollowUpDate] = useState("");
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [formError, setFormError] = useState<string | null>(null);

  const report = useMutation({
    mutationFn: () => api.post<PaymentDetail>(`/api/cn-requests/${requestId}/payment`, {
      status, amountPaid: amountPaid || undefined,
      paymentDate: paymentDate || undefined, followUpDate: followUpDate || undefined,
      taskId: data.activeTaskId ?? undefined, requestKey,
    }),
    onSuccess: (next) => {
      setStatus(""); setAmountPaid(""); setFollowUpDate(""); setRequestKey(crypto.randomUUID()); setFormError(null);
      onSaved(next);
    },
    onError: (e) => setFormError((e as Error).message),
  });

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <Label>{labels.update}</Label>
      <NativeSelect
        placeholder={labels.selectStatus}
        options={[{ value: "NOT_PAID", label: labels.notPaid }, { value: "PARTIAL_PAID", label: labels.partialPaid }, { value: "PAID", label: labels.paid }]}
        value={status}
        onChange={(e) => { setStatus(e.target.value as CnPaymentStatusValue | ""); setFormError(null); }}
      />
      {(status === "PAID" || status === "PARTIAL_PAID") && <div className="space-y-1"><Label>{labels.paymentDate} *</Label><Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} required /></div>}
      {status === "PARTIAL_PAID" && <div className="space-y-1"><Label>{labels.amountPaid} *</Label><Input type="number" min="0.01" step="0.01" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} required /></div>}
      {(status === "NOT_PAID" || status === "PARTIAL_PAID") && <div className="space-y-1"><Label>{labels.followUpDate} *</Label><Input type="date" min={data.events[0]?.eventDate} max={data.expiryDate ?? undefined} value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} required /></div>}
      {formError && <p className="text-sm text-destructive">{formError}</p>}
      <Button disabled={!status || report.isPending} onClick={() => report.mutate()}>{report.isPending ? labels.saving : labels.saveStatus}</Button>
    </div>
  );
}

/** ADMIN VERIFICATION — authoritative. Admin picks only the status (+ Amount Paid for Partial); never dates. */
function AdminVerifyForm({ requestId, labels, onSaved }: { requestId: string; labels: PaymentLabels; onSaved: (next: PaymentDetail) => void }) {
  const [status, setStatus] = useState<CnPaymentStatusValue | "">("");
  const [amountPaid, setAmountPaid] = useState("");
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [formError, setFormError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const verify = useMutation({
    mutationFn: () => api.post<PaymentDetail>(`/api/cn-requests/${requestId}/verify`, {
      status, amountPaid: amountPaid || undefined, requestKey,
    }),
    onSuccess: (next) => {
      setStatus(""); setAmountPaid(""); setRequestKey(crypto.randomUUID()); setFormError(null);
      onSaved(next);
    },
    onError: (e) => setFormError((e as Error).message),
    onSettled: () => { submittingRef.current = false; },
  });

  const submit = () => {
    if (submittingRef.current || !status) return;
    submittingRef.current = true;
    verify.mutate();
  };

  return (
    <div className="space-y-3 rounded-lg border border-success/40 bg-success/5 p-3">
      <Label>{labels.verify}</Label>
      <p className="text-xs text-muted-foreground">{labels.verifyHelp}</p>
      <NativeSelect
        placeholder={labels.selectVerifiedStatus}
        options={[{ value: "NOT_PAID", label: labels.notPaid }, { value: "PARTIAL_PAID", label: labels.partialPaid }, { value: "PAID", label: labels.paid }]}
        value={status}
        onChange={(e) => { setStatus(e.target.value as CnPaymentStatusValue | ""); setFormError(null); }}
      />
      {status === "PARTIAL_PAID" && <div className="space-y-1"><Label>{labels.amountPaid} *</Label><Input type="number" min="0.01" step="0.01" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} required /></div>}
      {formError && <p className="text-sm text-destructive">{formError}</p>}
      <Button disabled={!status || verify.isPending} onClick={submit}>{verify.isPending ? labels.verifying : labels.verify}</Button>
    </div>
  );
}
