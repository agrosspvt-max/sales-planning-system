"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDMY } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import { intensityLevel, shiftMonth } from "@/lib/task-analysis";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLabel } from "@/features/labels/label-ui";
import type { RescheduleCalendarPayload } from "./task-analysis.server";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** ONE colour scale (more rescheduled tasks = darker); the number inside each date carries the same information, so colour is never the only signal. */
const LEVEL_CLASS = ["bg-background", "bg-primary/10", "bg-primary/25", "bg-primary/45", "bg-primary/65 text-primary-foreground", "bg-primary/85 text-primary-foreground"];

export interface SelectedTask { key: string; label: string; trail: string[] }

/**
 * The reschedule calendar: SCHEDULED dates affected by rescheduling (never the days the changes were made). Overview = how many distinct rescheduled tasks involve each date,
 * for the SAME filtered population as the table (a focused date narrows only the table). Selected-task mode highlights one task's ordered date trail, numbered, and fades the rest.
 * Month navigation never changes the population's own date filter.
 */
export function RescheduleCalendar({ query, initialMonth, focusDate, onFocusDate, selected, onClearSelection }: {
  query: string; initialMonth: string; focusDate: string | null; onFocusDate: (date: string | null) => void; selected: SelectedTask | null; onClearSelection: () => void;
}) {
  const L = {
    title: useLabel("tasks.calendar.title"), legend: useLabel("tasks.calendar.legend"), note: useLabel("tasks.calendar.note"), fewer: useLabel("tasks.calendar.fewer"), more: useLabel("tasks.calendar.more"),
    period: useLabel("tasks.calendar.period_total"), monthTotal: useLabel("tasks.calendar.month_total"), selectedDate: useLabel("tasks.calendar.selected_date"), cellAria: useLabel("tasks.calendar.cell_aria"),
    none: useLabel("tasks.calendar.none"), loading: useLabel("tasks.calendar.loading"), error: useLabel("tasks.error"), prev: useLabel("calendar.prev_month"), next: useLabel("calendar.next_month"),
    clearTask: useLabel("tasks.select.clear"), trail: useLabel("tasks.select.trail"), original: useLabel("tasks.select.original"), current: useLabel("tasks.select.current"), selectedTask: useLabel("tasks.select.selected"),
    clearFocus: useLabel("tasks.focus.clear"),
  };
  const [month, setMonth] = useState(initialMonth);
  const { data, isLoading, error } = useQuery<RescheduleCalendarPayload>({
    queryKey: ["tasks", "calendar", query, month],
    queryFn: () => api.get<RescheduleCalendarPayload>(`/api/tasks/reschedule-calendar?${query}&month=${month}`),
  });
  const [y, m] = month.split("-").map(Number) as [number, number];
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  while (cells.length % 7 !== 0) cells.push(null);
  // Selected-task mode: which step numbers fall on which date (a revisited date carries several).
  const steps = new Map<string, number[]>();
  selected?.trail.forEach((d, i) => steps.set(d, [...(steps.get(d) ?? []), i + 1]));
  const lastStep = selected ? selected.trail.length : 0;

  return (
    <section className="space-y-3 rounded-lg border bg-background p-3 sm:p-4" aria-label={L.title} data-testid="reschedule-calendar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" aria-label={L.prev} onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="h-4 w-4" /></Button>
          <div className="min-w-[10rem] text-center text-sm font-semibold" data-testid="calendar-month">{MONTHS[m - 1]} {y}</div>
          <Button variant="outline" size="sm" aria-label={L.next} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight className="h-4 w-4" /></Button>
        </div>
        <div className="text-sm text-muted-foreground" data-testid="calendar-totals">
          {data ? <>{L.period.replace("{n}", String(data.periodTasks))} · {L.monthTotal.replace("{n}", String(data.monthTasks))}</> : null}
          {focusDate && data && <> · <span data-testid="calendar-selected-count" className="font-medium text-foreground">{L.selectedDate.replace("{date}", formatDMY(focusDate)).replace("{n}", String(data.days[focusDate] ?? 0))}</span></>}
        </div>
      </div>

      {selected && (
        <div className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm" data-testid="selected-task">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><span className="text-xs text-muted-foreground">{L.selectedTask}: </span><span className="font-medium">{selected.label}</span></div>
            <Button size="sm" variant="outline" onClick={onClearSelection}>{L.clearTask}</Button>
          </div>
          <div className="mt-2 text-xs font-medium text-muted-foreground">{L.trail}</div>
          <ol className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1" data-testid="date-trail">
            {selected.trail.map((d, i) => (
              <li key={`${d}-${i}`} className="flex items-center gap-1">
                <button type="button" onClick={() => setMonth(d.slice(0, 7))} className="rounded border bg-background px-2 py-0.5 tabular-nums hover:bg-accent/40">
                  <span className="mr-1 font-semibold">{i + 1}</span>{formatDMY(d)}{i === 0 && <span className="ml-1 text-xs text-muted-foreground">({L.original})</span>}{i === lastStep - 1 && lastStep > 1 && <span className="ml-1 text-xs text-muted-foreground">({L.current})</span>}
                </button>
                {i < selected.trail.length - 1 && <span aria-hidden>→</span>}
              </li>
            ))}
          </ol>
        </div>
      )}

      {isLoading ? <Skeleton className="h-72 w-full" aria-label={L.loading} /> : error || !data ? <p role="alert" className="text-sm text-destructive">{L.error}</p> : (
        <>
          <div className="overflow-hidden rounded-md border">
            <div className="grid grid-cols-7 border-b bg-muted/30 text-xs font-medium text-muted-foreground">{WEEKDAYS.map((w) => <div key={w} className="px-1 py-2 text-center">{w}</div>)}</div>
            <div className="grid grid-cols-7">
              {cells.map((dk, i) => {
                if (!dk) return <div key={i} className="min-h-[3.5rem] border-b border-r bg-muted/10 sm:min-h-[5rem] [&:nth-child(7n)]:border-r-0" />;
                const count = data.days[dk] ?? 0;
                const level = intensityLevel(count, data.max);
                const onTrail = steps.has(dk);
                const faded = !!selected && !onTrail;
                return (
                  <button
                    key={dk} type="button" data-date={dk} data-level={level} data-count={count} aria-pressed={focusDate === dk}
                    aria-label={L.cellAria.replace("{date}", formatDMY(dk)).replace("{n}", String(count))}
                    onClick={() => onFocusDate(focusDate === dk ? null : dk)}
                    className={cn(
                      "relative min-h-[3.5rem] border-b border-r p-1 text-left transition-colors hover:brightness-95 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-[5rem] sm:p-2 [&:nth-child(7n)]:border-r-0",
                      selected ? (onTrail ? "bg-warning/30" : "bg-background") : LEVEL_CLASS[level],
                      focusDate === dk && "ring-2 ring-inset ring-foreground",
                      onTrail && "ring-2 ring-inset ring-warning",
                      faded && "opacity-30",
                    )}
                  >
                    <span className="text-xs tabular-nums">{Number(dk.slice(-2))}</span>
                    {!selected && count > 0 && <span className="absolute inset-0 flex items-center justify-center text-base font-semibold tabular-nums sm:text-xl" data-testid="cell-count">{count}</span>}
                    {onTrail && <span className="absolute inset-x-0 bottom-1 flex flex-wrap justify-center gap-0.5" data-testid="cell-steps">{steps.get(dk)!.map((n) => <span key={n} className="rounded-full bg-warning px-1.5 text-[11px] font-bold leading-4 text-warning-foreground">{n}</span>)}</span>}
                  </button>
                );
              })}
            </div>
          </div>
          {data.monthTasks === 0 && !selected && <p className="text-sm text-muted-foreground" data-testid="calendar-none">{L.none}</p>}
          {!selected && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" data-testid="calendar-legend">
              <span className="flex items-center gap-1">{L.fewer}{LEVEL_CLASS.slice(1).map((c, i) => <span key={i} className={cn("h-4 w-6 rounded border", c.split(" ")[0])} aria-hidden />)}{L.more}</span>
              <span className="min-w-0 flex-1">{L.legend}</span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{L.note}</p>
          {focusDate && <Button size="sm" variant="ghost" onClick={() => onFocusDate(null)}>{L.clearFocus}</Button>}
        </>
      )}
    </section>
  );
}
