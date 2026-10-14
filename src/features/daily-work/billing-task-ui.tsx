"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { DateInputDMY } from "@/components/ui/date-input-dmy";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import type { BillingTaskDetail, BillingTaskDto } from "./billing-task.server";

const dateText = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; };

/** The next calendar day after a business date (YYYY-MM-DD) — the earliest date an automatic task can be moved to. */
export function dayAfter(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Reschedule popup for ONE automatic (Billing Exception) task, opened from the calendar icon on its Today's Plan row. Shows the dealer, the planned amount (read-only) and the
 * current scheduled date; the new date must be AFTER today (the server enforces it too). The same task moves — see rescheduleBillingTask.
 */
export function BillingTaskRescheduleDialog({ task, today, onClose, onDone }: { task: BillingTaskDto; today: string; onClose: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const L = {
    title: useLabel("daily_work.billing_tasks.reschedule_title"), hint: useLabel("daily_work.billing_tasks.reschedule_hint"), cancel: useLabel("daily_work.action.cancel"),
    save: useLabel("daily_work.billing_tasks.action.reschedule"), dealer: useLabel("daily_work.billing_tasks.col.dealer"), amount: useLabel("daily_work.billing_tasks.reschedule_amount"),
    current: useLabel("daily_work.billing_tasks.reschedule_current_date"), next: useLabel("daily_work.billing_tasks.reschedule_new_date"), afterToday: useLabel("daily_work.billing_tasks.error.after_today"),
  };
  const min = dayAfter(today);
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () => api.post(`/api/billing-exception-tasks/${task.taskId}/reschedule`, { taskDate: date }),
    onSuccess: () => { for (const key of ["calendar", "calendar-upcoming"]) void queryClient.invalidateQueries({ queryKey: [key] }); onDone(); }, // the task moves on the Calendar too
    onError: (e) => setError((e as Error).message),
  });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= min;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !mut.isPending) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-sm overflow-y-auto" data-testid="billing-task-reschedule">
        <DialogHeader><DialogTitle>{L.title}</DialogTitle></DialogHeader>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{L.dealer}</dt><dd className="font-medium">{task.dealerName}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{L.amount}</dt><dd className="font-medium tabular-nums" data-testid="reschedule-amount">{formatCurrency(task.amount)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{L.current}</dt><dd className="font-medium tabular-nums">{dateText(task.taskDate)}</dd></div>
        </dl>
        <div className="space-y-1.5">
          <Label htmlFor="billing-task-new-date">{L.next}</Label>
          <DateInputDMY id="billing-task-new-date" aria-label={L.next} value={date} min={min} onChange={(v) => { setDate(v); setError(null); }} />
        </div>
        <p className="text-xs text-muted-foreground">{L.hint}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mut.isPending}>{L.cancel}</Button>
          <Button onClick={() => { if (!mut.isPending && valid) { setError(null); mut.mutate(); } else if (!valid) setError(L.afterToday); }} disabled={mut.isPending || !date}>{L.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The originating Billing Exception behind a task — also opened from the Calendar (the endpoint authorizes the owner, the supervising RM and an authorized administrative viewer). */
export function BillingTaskDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const L = {
    title: useLabel("daily_work.billing_tasks.details_title"), dealer: useLabel("daily_work.billing_tasks.col.dealer"), amount: useLabel("daily_work.billing_tasks.col.amount"),
    billNo: useLabel("daily_work.billing_tasks.detail.bill_no"), auth: useLabel("daily_work.billing_tasks.detail.auth_person"), billingDate: useLabel("daily_work.billing_tasks.detail.billing_date"),
    by: useLabel("daily_work.billing_tasks.detail.created_by"), promised: useLabel("daily_work.billing_tasks.detail.promised"), owner: useLabel("daily_work.billing_tasks.detail.owner"),
    exception: useLabel("daily_work.billing_tasks.detail.exception"), scheduled: useLabel("daily_work.billing_tasks.detail.scheduled"), close: useLabel("daily_work.action.cancel"),
  };
  const { data, isLoading, error } = useQuery<BillingTaskDetail>({ queryKey: ["billing-task-detail", id], queryFn: () => api.get(`/api/billing-exception-tasks/${id}`) });
  const row = (label: string, value: React.ReactNode) => <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-medium">{value}</dd></div>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader><DialogTitle>{L.title}</DialogTitle></DialogHeader>
        {isLoading ? <Skeleton className="h-28 w-full" /> : error || !data ? <p role="alert" className="text-sm text-destructive">{(error as Error | null)?.message || "—"}</p> : (
          <dl data-testid="billing-task-detail">
            {row(L.dealer, data.dealerName)}{row(L.amount, formatCurrency(data.amount))}{row(L.billNo, data.billNo ?? "—")}{row(L.auth, data.authPerson ?? "—")}
            {row(L.billingDate, data.billingDate ? dateText(data.billingDate) : "—")}{row(L.scheduled, dateText(data.taskDate))}{row(L.promised, dateText(data.promisedDate))}{row(L.owner, data.officerName)}{row(L.by, data.createdByName ?? "—")}
            {row(L.exception, data.exceptionStatus === "CURRENT" ? "Current" : "Resolved")}
          </dl>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>{L.close}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
