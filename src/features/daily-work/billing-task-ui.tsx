"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatCurrency } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DateInputDMY } from "@/components/ui/date-input-dmy";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLabel } from "@/features/labels/label-ui";
import type { BillingTaskDetail, BillingTaskDto } from "./billing-task.server";

const dateText = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; };

/**
 * Billing Exception tasks of today's editable Recovery rows. Own source, own endpoints (/api/billing-exception-tasks/…) — never the CN ones. Shown whenever such a task
 * exists, regardless of the Auto Tasks container setting, because the submit gate counts them (a hidden task that blocks submission would be a trap).
 */
export function BillingTaskPanel({ tasks, locked, onChanged }: { tasks: BillingTaskDto[]; locked: boolean; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const refreshCalendar = () => { for (const key of ["calendar", "calendar-upcoming"]) void queryClient.invalidateQueries({ queryKey: [key] }); }; // a moved task moves on the Calendar too
  const L = {
    title: useLabel("daily_work.billing_tasks.title"), hint: useLabel("daily_work.billing_tasks.hint"), dealer: useLabel("daily_work.billing_tasks.col.dealer"),
    amount: useLabel("daily_work.billing_tasks.col.amount"), taskType: useLabel("daily_work.billing_tasks.col.task_type"), planType: useLabel("daily_work.billing_tasks.col.plan_type"),
    date: useLabel("daily_work.billing_tasks.col.date"), overdue: useLabel("daily_work.billing_tasks.overdue"), rescheduled: useLabel("daily_work.billing_tasks.rescheduled"),
    confirm: useLabel("daily_work.billing_tasks.action.confirm"), details: useLabel("daily_work.billing_tasks.action.details"), reschedule: useLabel("daily_work.billing_tasks.action.reschedule"),
    confirmed: useLabel("daily_work.billing_tasks.confirmed"), billing: useLabel("daily_work.task_type.billing_exception"), recovery: useLabel("daily_work.section.recovery"),
  };
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rescheduleTask, setRescheduleTask] = useState<BillingTaskDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useMutation({
    mutationFn: (id: string) => api.post(`/api/billing-exception-tasks/${id}/confirm`, {}),
    onSuccess: () => { setError(null); onChanged(); },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <section className="space-y-2 rounded-lg border p-3" aria-label={L.title} data-testid="billing-task-panel">
      <div><h3 className="text-sm font-semibold">{L.title}</h3><p className="text-xs text-muted-foreground">{L.hint}</p></div>
      <div className="overflow-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{L.dealer}</TableHead><TableHead className="text-right">{L.amount}</TableHead><TableHead className="hidden sm:table-cell">{L.taskType}</TableHead><TableHead className="hidden sm:table-cell">{L.planType}</TableHead><TableHead>{L.date}</TableHead><TableHead className="hidden sm:table-cell" />
          </TableRow></TableHeader>
          <TableBody>
            {tasks.map((t) => (
              <TableRow key={t.taskId} data-billing-task-id={t.taskId}>
                <TableCell className="font-medium">
                  {t.dealerName}
                  {/* narrow screens: Task Type / Plan Type move under the dealer instead of widening the table */}
                  <span className="block text-xs font-normal text-muted-foreground sm:hidden">{L.billing} · {L.recovery}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(t.amount)}</TableCell>
                <TableCell className="hidden sm:table-cell">{L.billing}</TableCell>
                <TableCell className="hidden sm:table-cell">{L.recovery}</TableCell>
                <TableCell>
                  {dateText(t.promisedDate)}
                  {t.taskDate !== t.promisedDate && <span className="block text-xs text-muted-foreground">{L.rescheduled}: {dateText(t.taskDate)}</span>}
                  {t.overdue && <Badge variant="warning" className="mt-0.5">{L.overdue}</Badge>}
                  {/* narrow screens: the actions wrap under the date instead of widening the table */}
                  <div className="mt-1.5 sm:hidden"><div className="flex flex-wrap items-center justify-start gap-1.5">
                    {t.confirmed ? <Badge variant="success">{L.confirmed}</Badge> : <Button size="sm" disabled={locked || confirm.isPending} onClick={() => confirm.mutate(t.taskId)}>{L.confirm}</Button>}
                    <Button size="sm" variant="outline" onClick={() => setDetailId(t.taskId)}>{L.details}</Button>
                    <Button size="sm" variant="ghost" disabled={locked} onClick={() => setRescheduleTask(t)}>{L.reschedule}</Button>
                  </div></div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {t.confirmed ? <Badge variant="success">{L.confirmed}</Badge> : <Button size="sm" disabled={locked || confirm.isPending} onClick={() => confirm.mutate(t.taskId)}>{L.confirm}</Button>}
                    <Button size="sm" variant="outline" onClick={() => setDetailId(t.taskId)}>{L.details}</Button>
                    <Button size="sm" variant="ghost" disabled={locked} onClick={() => setRescheduleTask(t)}>{L.reschedule}</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {detailId && <BillingTaskDetailDialog id={detailId} onClose={() => setDetailId(null)} />}
      {rescheduleTask && <BillingTaskRescheduleDialog task={rescheduleTask} onClose={() => setRescheduleTask(null)} onDone={() => { setRescheduleTask(null); onChanged(); refreshCalendar(); }} />}
    </section>
  );
}

function BillingTaskRescheduleDialog({ task, onClose, onDone }: { task: BillingTaskDto; onClose: () => void; onDone: () => void }) {
  const title = useLabel("daily_work.billing_tasks.reschedule_title"), hint = useLabel("daily_work.billing_tasks.reschedule_hint"), cancel = useLabel("daily_work.action.cancel"), save = useLabel("daily_work.billing_tasks.action.reschedule");
  const [date, setDate] = useState(task.taskDate);
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () => api.post(`/api/billing-exception-tasks/${task.taskId}/reschedule`, { taskDate: date }),
    onSuccess: onDone, onError: (e) => setError((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !mut.isPending) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-sm overflow-y-auto">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{task.dealerName} · {formatCurrency(task.amount)}</p>
        <DateInputDMY aria-label={title} value={date} onChange={setDate} />
        <p className="text-xs text-muted-foreground">{hint}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mut.isPending}>{cancel}</Button>
          <Button onClick={() => { if (!mut.isPending) { setError(null); mut.mutate(); } }} disabled={mut.isPending || !date}>{save}</Button>
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
