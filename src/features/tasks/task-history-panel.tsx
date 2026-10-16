"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDMY, formatDateTimeDMY } from "@/lib/date-format";
import { cn, formatCurrency } from "@/lib/utils";
import { employeeHeaderText } from "@/lib/calendar";
import { previewHistory } from "@/lib/task-analysis";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLabel } from "@/features/labels/label-ui";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import type { TaskHistoryPayload, TaskRow } from "./task-analysis.server";
import { useTaskText } from "./task-text";

/**
 * One task and its full, READ-ONLY rescheduling history: identity, original / current date, total reschedules, net movement and a chronological timeline. A long history shows a
 * preview with an explicit "N moves not shown" marker. Opening it only reads; it never creates, completes or reschedules anything and sends no notification.
 * Side panel on a desktop, full-width sheet on a phone.
 */
export function TaskHistoryPanel({ row, onClose, onShowOnCalendar }: { row: TaskRow; onClose: () => void; onShowOnCalendar: (history: TaskHistoryPayload) => void }) {
  const T = useTaskText();
  const L = {
    title: useLabel("tasks.panel.title"), close: useLabel("tasks.panel.close"), originally: useLabel("tasks.panel.originally_due"), movedBy: useLabel("tasks.panel.moved_by"), current: useLabel("tasks.panel.current_date"),
    total: useLabel("tasks.panel.total"), net: useLabel("tasks.panel.net"), noMoves: useLabel("tasks.panel.no_moves"), viewFull: useLabel("tasks.panel.view_full"), less: useLabel("tasks.panel.show_less"), omitted: useLabel("tasks.panel.omitted"),
    partial: useLabel("tasks.panel.partial"), unavailable: useLabel("tasks.panel.unavailable"), chain: useLabel("tasks.panel.chain_note"), reason: useLabel("tasks.panel.reason"), readOnly: useLabel("tasks.panel.read_only"),
    show: useLabel("tasks.show_on_calendar"), abandonedBy: useLabel("tasks.panel.abandoned"), abandonReason: useLabel("tasks.panel.abandon_reason"), completedBy: useLabel("tasks.panel.completed"), completedAmount: useLabel("tasks.panel.completed_amount"), error: useLabel("tasks.error"), loading: useLabel("tasks.loading"), colOriginal: useLabel("tasks.col.original"), colCurrent: useLabel("tasks.col.current"),
  };
  const [full, setFull] = useState(false);
  const { data, isLoading, error } = useQuery<TaskHistoryPayload>({ queryKey: ["tasks", "history", row.sourceType, row.taskId], queryFn: () => api.get<TaskHistoryPayload>(`/api/tasks/history/${row.sourceType}/${encodeURIComponent(row.taskId)}`) });
  const task = data?.task ?? row;
  const segments = useMemo(() => previewHistory(data?.events ?? [], full), [data, full]);
  const long = (data?.events.length ?? 0) > 5;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={L.title} onKeyDown={(e) => e.key === "Escape" && onClose()} data-testid="task-history-panel">
      <button type="button" className="absolute inset-0 bg-black/30" aria-label={L.close} onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l bg-background p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{L.title}</h2>
            <p className="text-xs text-muted-foreground">{L.readOnly}</p>
          </div>
          <Button size="sm" variant="ghost" aria-label={L.close} onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        <div className="space-y-1 rounded-md border p-3 text-sm" data-testid="history-task">
          <div className="font-semibold">{T.heading(task)}</div>
          <div>{employeeHeaderText(task.ownerName, task.territory, task.state)}</div>
          <div className="text-muted-foreground">{T.detail(task, (id, name) => <DealerName id={id} name={name} />)}{task.amount != null ? ` · ${formatCurrency(task.amount)}` : ""}</div>
          <div className="flex flex-wrap items-center gap-2 pt-1"><Badge variant={T.statusVariant(task.status)}>{T.status(task.status)}</Badge>{task.historyState !== "COMPLETE" && <Badge variant="warning">{task.historyState === "PARTIAL" ? T.partialBadge : T.unavailableBadge}</Badge>}</div>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-muted-foreground">{L.colOriginal}</dt><dd className="font-medium tabular-nums" data-testid="history-original">{formatDMY(task.originalDate)}{!task.originalVerified && " *"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{L.colCurrent}</dt><dd className="font-medium tabular-nums" data-testid="history-current">{formatDMY(task.currentDate)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{L.total}</dt><dd className="font-medium" data-testid="history-total">{T.moves(task)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{L.net}</dt><dd className="font-medium" data-testid="history-net">{T.net(task.daysMoved)}</dd></div>
        </dl>

        {task.historyState === "PARTIAL" && <p className="mt-3 rounded-md bg-warning/10 p-2 text-sm" data-testid="history-partial">{L.partial}</p>}
        {task.historyState === "UNAVAILABLE" && <p className="mt-3 rounded-md bg-warning/10 p-2 text-sm" data-testid="history-unavailable">{L.unavailable}</p>}
        {data && !data.chainOk && <p className="mt-2 text-xs text-muted-foreground">{L.chain}</p>}

        <div className="mt-4 flex-1">
          {isLoading ? <Skeleton className="h-32 w-full" aria-label={L.loading} /> : error || !data ? <p role="alert" className="text-sm text-destructive">{L.error}</p> : data.events.length === 0 ? (
            task.historyState === "COMPLETE" ? <p className="text-sm text-muted-foreground" data-testid="history-empty">{L.noMoves}</p> : null
          ) : (
            <ol className="space-y-0 text-sm" data-testid="history-timeline">
              <li className="font-semibold">{L.originally.replace("{date}", formatDMY(data.events[0]!.previousDate))}</li>
              {segments.map((seg, i) => seg.kind === "omitted" ? (
                <li key={`o${i}`} className="my-1 border-l-2 border-dashed pl-3 text-xs italic text-muted-foreground" data-testid="history-omitted">⋮ {L.omitted.replace("{n}", String(seg.count))}</li>
              ) : (
                <li key={seg.event.id} className="border-l-2 pl-3" data-testid="history-step">
                  <div className="py-1 text-xs text-muted-foreground">↓ {L.movedBy.replace("{name}", seg.event.actorName)} · {formatDateTimeDMY(seg.event.createdAt)}{seg.event.reason ? ` · ${L.reason.replace("{text}", seg.event.reason)}` : ""}</div>
                  <div className={cn("font-semibold tabular-nums", seg.index === data.events.length - 1 && "text-primary")}>
                    {seg.index === data.events.length - 1 ? L.current.replace("{date}", formatDMY(seg.event.newDate)) : formatDMY(seg.event.newDate)}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">({formatDMY(seg.event.previousDate)} → {formatDMY(seg.event.newDate)})</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {/* How the task ENDED (a submitted Daily Report outcome): Completed with its Actual, or Abandoned — in red, with who, when and the reason. */}
          {data && data.outcomes.filter((o) => o.outcome !== "RESCHEDULED").map((o, i) => (
            <div key={i} className={cn("mt-3 rounded-md border p-3 text-sm", o.outcome === "ABANDONED" ? "border-destructive/50 bg-destructive/5" : "border-success/50 bg-success/5")} data-testid={o.outcome === "ABANDONED" ? "history-abandoned" : "history-completed"}>
              <div className={cn("font-semibold", o.outcome === "ABANDONED" && "text-destructive")}>{T.status(o.outcome === "ABANDONED" ? "ABANDONED" : "COMPLETED")}</div>
              <div className="text-xs text-muted-foreground">{(o.outcome === "ABANDONED" ? L.abandonedBy : L.completedBy).replace("{name}", o.committedByName ?? "—").replace("{when}", formatDateTimeDMY(o.committedAt))}</div>
              {o.outcome === "ABANDONED" && o.reason && <p className="mt-1 whitespace-pre-wrap" data-testid="history-abandon-reason">{L.abandonReason.replace("{text}", o.reason)}</p>}
              {o.outcome === "COMPLETED" && o.actualAmount != null && <p className="mt-1">{L.completedAmount.replace("{amount}", formatCurrency(o.actualAmount))}</p>}
            </div>
          ))}
          {data && long && <Button size="sm" variant="outline" className="mt-3" onClick={() => setFull((v) => !v)}>{full ? L.less : L.viewFull}</Button>}
        </div>
        {data && data.events.length > 0 && <Button size="sm" className="mt-4" onClick={() => onShowOnCalendar(data)}>{L.show}</Button>}
      </aside>
    </div>
  );
}
