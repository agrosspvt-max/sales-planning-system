"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, Clock3, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDMY, formatDateTimeDMY } from "@/lib/date-format";
import { cn, formatCurrency } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLabel } from "@/features/labels/label-ui";
import { useTaskText } from "@/features/tasks/task-text";
import { useAbandonText } from "./abandon-text";
import type { TaskHistoryPayload } from "@/features/tasks/task-analysis.server";

export interface ReviewTaskSelection { key: string; trigger?: HTMLButtonElement }

/** Stable identity only: the reviewed day and Performance filters must never limit this query. */
export function reviewTaskHistoryUrl(key: string): string {
  const separator = key.indexOf(":");
  return `/api/tasks/history/${encodeURIComponent(key.slice(0, separator))}/${encodeURIComponent(key.slice(separator + 1))}`;
}

/** Nested modal: Escape/backdrop close only the sidebar, and focus returns to the clicked tag. */
export function ReviewTaskHistoryDrawer({ selection, onClose, onShowOnCalendar }: {
  selection: ReviewTaskSelection; onClose: () => void; onShowOnCalendar?: (history: TaskHistoryPayload) => void;
}) {
  const title = useLabel("daily_work.review.history.title");
  const showOnCalendar = useLabel("tasks.show_on_calendar");
  const description = useLabel("tasks.panel.read_only");
  const loading = useLabel("tasks.loading");
  const failed = useLabel("tasks.error");
  const retry = useLabel("daily_work.review.history.retry");
  const { data, isLoading, error, refetch } = useQuery<TaskHistoryPayload>({
    queryKey: ["review-task-history", selection.key],
    queryFn: () => api.get<TaskHistoryPayload>(reviewTaskHistoryUrl(selection.key)),
    staleTime: 0,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="bottom-0 top-0 left-auto right-0 flex h-dvh max-h-dvh w-full max-w-xl translate-x-0 translate-y-0 flex-col gap-4 overflow-y-auto border-y-0 border-r-0 p-6 sm:rounded-none"
        data-testid="review-task-history-drawer"
        onCloseAutoFocus={(event) => {
          if (selection.trigger?.isConnected) { event.preventDefault(); selection.trigger.focus(); }
        }}
      >
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        {isLoading ? <Skeleton className="h-64 w-full" aria-label={loading} /> : error || !data ? (
          <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{failed}</p><Button variant="outline" onClick={() => void refetch()}>{retry}</Button></div>
        ) : <>
          <ReviewTaskTimeline history={data} />
          {onShowOnCalendar && data.events.length > 0 && <Button size="sm" className="mt-auto shrink-0" onClick={() => onShowOnCalendar(data)}>{showOnCalendar}</Button>}
        </>}
      </DialogContent>
    </Dialog>
  );
}

/** CN timeline's visual pattern: vertical line, circular markers, name + IST time, and notes. No date filtering or move preview. */
export function ReviewTaskTimeline({ history }: { history: TaskHistoryPayload }) {
  const T = useTaskText();
  const abandon = useAbandonText();
  const L = {
    title: useLabel("daily_work.review.history.title"), times: useLabel("daily_work.review.history.times"), initiated: useLabel("daily_work.review.history.initiated"), original: useLabel("daily_work.review.history.original"), unknown: useLabel("daily_work.review.history.unknown_start"),
    by: useLabel("daily_work.review.history.by"), rescheduled: useLabel("daily_work.review.history.rescheduled"), move: useLabel("daily_work.review.history.move"), result: useLabel("daily_work.review.history.result"), workDate: useLabel("daily_work.review.history.work_date"),
    current: useLabel("tasks.col.current"), total: useLabel("tasks.panel.total"), partial: useLabel("tasks.panel.partial"), unavailable: useLabel("tasks.panel.unavailable"), chain: useLabel("tasks.panel.chain_note"),
    reason: useLabel("tasks.panel.reason"), amount: useLabel("tasks.panel.completed_amount"),
  };
  const { task } = history;
  const events = [
    ...history.events.map((e) => ({ id: `move:${e.id}`, at: e.createdAt, kind: "move" as const, move: e })),
    // A rescheduled outcome already has its authoritative TaskRescheduleEvent. Show it once.
    ...history.outcomes.filter((o) => o.outcome !== "RESCHEDULED").map((o, i) => ({ id: `outcome:${i}`, at: o.committedAt, kind: "outcome" as const, outcome: o })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return (
    <div className="space-y-5">
      <div className="space-y-1 rounded-md border p-3 text-sm">
        <p className="font-semibold">{task.dealerName || task.marketName || task.description || T.heading(task)}</p>
        <p className="text-muted-foreground">{task.ownerName} · {T.heading(task)}</p>
        <Badge variant={T.statusVariant(task.status)}>{T.status(task.status)}</Badge>
        <dl className="grid grid-cols-2 gap-3 pt-2">
          <div><dt className="text-xs text-muted-foreground">{L.current}</dt><dd className="tabular-nums">{formatDMY(task.currentDate)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{L.total}</dt><dd>{T.moves(task)}</dd></div>
        </dl>
      </div>
      {task.historyState !== "COMPLETE" && <p className="rounded-md bg-warning/10 p-3 text-sm" role="note">{task.historyState === "PARTIAL" ? L.partial : L.unavailable}</p>}
      {!history.chainOk && <p className="text-xs text-muted-foreground">{L.chain}</p>}
      <section aria-label={L.title}>
        <p className="mb-4 text-right text-xs text-muted-foreground">{L.times}</p>
        <ol className="ml-3 space-y-0 border-l-2 border-border" data-testid="review-task-timeline">
          <TimelineStep title={history.origin ? L.initiated : L.original} at={history.origin?.createdAt} actor={history.origin?.actorName} byLabel={L.by}>
            <p>{L.original}: {formatDMY(task.originalDate)}{!task.originalVerified && " *"}</p>
            {!history.origin && <p className="text-xs text-muted-foreground">{L.unknown}</p>}
          </TimelineStep>
          {events.map((e) => {
            if (e.kind === "move") return <TimelineStep key={e.id} title={L.rescheduled} at={e.at} actor={e.move.actorName} byLabel={L.by} testId="review-task-move">
              <p className="font-medium tabular-nums">{L.move.replace("{from}", formatDMY(e.move.previousDate)).replace("{to}", formatDMY(e.move.newDate))}</p>
              {e.move.reason && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{L.reason.replace("{text}", e.move.reason)}</p>}
            </TimelineStep>;
            const o = e.outcome;
            const abandoned = o.outcome === "ABANDONED";
            return <TimelineStep key={e.id} title={abandoned ? T.status("ABANDONED") : L.result} at={e.at} actor={o.committedByName} byLabel={L.by} tone={abandoned ? "red" : "blue"}>
              <p>{L.workDate.replace("{date}", formatDMY(o.workDate))}</p>
              {o.actualAmount != null && <p>{L.amount.replace("{amount}", formatCurrency(o.actualAmount))}</p>}
              {(o.reasonCode || o.reason) && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{abandoned ? abandon.summary(o.reasonCode, o.reason) : o.reason}</p>}
            </TimelineStep>;
          })}
          {task.status === "COMPLETED" && <TimelineStep title={T.status("COMPLETED")} byLabel={L.by} tone="green" />}
        </ol>
      </section>
    </div>
  );
}

function TimelineStep({ title, at, actor, byLabel, tone = "blue", children, testId }: {
  title: string; at?: string; actor?: string | null; byLabel: string; tone?: "blue" | "green" | "red"; children?: React.ReactNode; testId?: string;
}) {
  const color = tone === "green" ? "border-success bg-success/10 text-success" : tone === "red" ? "border-destructive bg-destructive/10 text-destructive" : "border-primary bg-background text-primary";
  const Icon = tone === "green" ? Check : tone === "red" ? X : Clock3;
  return <li className="relative pb-6 pl-6 last:pb-0" data-testid={testId}>
    <span className={cn("absolute -left-[13px] top-0 flex h-6 w-6 items-center justify-center rounded-full border-2", color)} aria-hidden><Icon className="h-3.5 w-3.5" /></span>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className={cn("text-sm font-semibold", tone === "red" && "text-destructive", tone === "green" && "text-success")}>{title}</p>
      {at && <time dateTime={at} className="text-xs text-muted-foreground">{formatDateTimeDMY(at)}</time>}
    </div>
    {actor && <p className="mt-1 break-words text-xs text-muted-foreground">{byLabel.replace("{name}", actor)}</p>}
    {children && <div className="mt-2 space-y-1 text-sm">{children}</div>}
  </li>;
}
