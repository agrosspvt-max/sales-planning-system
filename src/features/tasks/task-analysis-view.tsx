"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { CalendarDays } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDMY } from "@/lib/date-format";
import { cn, formatCurrency } from "@/lib/utils";
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { employeeHeaderText } from "@/lib/calendar";
import { taskQueryString, type TaskFilterState } from "@/lib/task-analysis";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateInputDMY } from "@/components/ui/date-input-dmy";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Th, useLabel } from "@/features/labels/label-ui";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { RescheduleCalendar, type SelectedTask } from "./reschedule-calendar";
import { TaskHistoryPanel } from "./task-history-panel";
import { useTaskText } from "./task-text";
import { useAbandonText } from "@/features/daily-work/abandon-text";
import type { TaskAnalysisPayload, TaskHistoryPayload, TaskRow } from "./task-analysis.server";

const CALENDAR_PREF = "performance.tasks.rescheduleCalendar"; // the app's existing preference pattern: a guarded localStorage value (never required for the page to work)
const readPref = (): boolean => { try { return window.localStorage.getItem(CALENDAR_PREF) === "open"; } catch { return false; } };
const writePref = (open: boolean) => { try { window.localStorage.setItem(CALENDAR_PREF, open ? "open" : "closed"); } catch { /* preference only */ } };

/** Performance → Tasks. All state that must survive switching back to Performance lives in the parent (`filters`); the calendar's open / closed choice is a remembered preference. */
export function TaskAnalysisView({ role, filters, onFilters }: { role: Role; filters: TaskFilterState; onFilters: (next: TaskFilterState) => void }) {
  const T = useTaskText();
  const abandon = useAbandonText();
  const L = {
    auto: useLabel("tasks.type.auto"), manual: useLabel("tasks.type.manual"), all: useLabel("tasks.type.all"), basis: useLabel("tasks.filter.basis"), bOriginal: useLabel("tasks.basis.original"), bMoved: useLabel("tasks.basis.rescheduled_on"),
    from: useLabel("tasks.filter.from"), to: useLabel("tasks.filter.to"), allStates: useLabel("daily_work.performance.filter.all_states"), state: useLabel("daily_work.performance.col.state"),
    employee: useLabel("tasks.filter.employee"), allEmployees: useLabel("tasks.filter.all_employees"), section: useLabel("tasks.filter.section"), allSections: useLabel("tasks.filter.all_sections"),
    source: useLabel("tasks.filter.source"), allSources: useLabel("tasks.filter.all_sources"), status: useLabel("tasks.filter.status"), allStatuses: useLabel("tasks.filter.all_statuses"),
    noteOriginal: useLabel("tasks.basis.note_original"), noteMoved: useLabel("tasks.basis.note_rescheduled"), range: useLabel("tasks.error.range"),
    sTotal: useLabel("tasks.summary.total"), sDone: useLabel("tasks.summary.completed"), sPending: useLabel("tasks.summary.pending"), sOverdue: useLabel("tasks.summary.overdue"), sCancelled: useLabel("tasks.summary.cancelled"), sAbandoned: useLabel("tasks.summary.abandoned"), bAbandoned: useLabel("tasks.basis.abandoned_on"), noteAbandoned: useLabel("tasks.basis.note_abandoned"), stAbandoned: useLabel("tasks.status.abandoned"),
    sMovedTasks: useLabel("tasks.summary.rescheduled_tasks"), sMoves: useLabel("tasks.summary.total_reschedules"), sAvg: useLabel("tasks.summary.average"), historyNote: useLabel("tasks.summary.history_note"),
    secSALES: useLabel("daily_work.section.sales"), secRECOVERY: useLabel("daily_work.section.recovery"), secAPPOINTMENT: useLabel("daily_work.section.appointment"), secVISITS: useLabel("daily_work.section.visits"), secOTHERS: useLabel("daily_work.section.others"),
    subREGULAR: useLabel("calendar.subtype.regular"), subSCHEME: useLabel("calendar.subtype.scheme"), subBILLING: useLabel("calendar.subtype.billing_exception"), subCN: useLabel("calendar.subtype.cn_request"),
    stCompleted: useLabel("tasks.status.completed"), stPending: useLabel("tasks.status.pending"), stOverdue: useLabel("tasks.status.overdue"), stCancelled: useLabel("tasks.status.cancelled"),
    calShow: useLabel("tasks.calendar.show"), calHide: useLabel("tasks.calendar.hide"), empty: useLabel("tasks.empty"), loading: useLabel("tasks.loading"), error: useLabel("tasks.error"),
    page: useLabel("tasks.page"), prev: useLabel("tasks.previous"), next: useLabel("tasks.next"), history: useLabel("tasks.history.open"), showOnCal: useLabel("tasks.show_on_calendar"),
    focusBanner: useLabel("tasks.focus.banner"), focusClear: useLabel("tasks.focus.clear"), unverified: useLabel("tasks.footnote.unverified"),
  };
  const isAdmin = isAdministrativeRole(role);
  const isSO = role === Role.SALES_OFFICER;
  const set = (patch: Partial<TaskFilterState>) => onFilters({ ...filters, page: 1, ...patch }); // any filter change returns to page 1; a date focus is dropped with it unless re-set
  const rangeBad = filters.from > filters.to;

  const [calendarOpen, setCalendarOpen] = useState(false);
  useEffect(() => { setCalendarOpen(readPref()); }, []);
  const toggleCalendar = () => { const next = !calendarOpen; setCalendarOpen(next); writePref(next); };
  const [selected, setSelected] = useState<SelectedTask | null>(null);
  const [panel, setPanel] = useState<TaskRow | null>(null);

  const { data, isLoading, error } = useQuery<TaskAnalysisPayload>({
    queryKey: ["tasks", "analysis", taskQueryString(filters, "table")],
    queryFn: () => api.get<TaskAnalysisPayload>(`/api/tasks/analysis?${taskQueryString(filters, "table")}`),
    enabled: !rangeBad, placeholderData: (prev) => prev,
  });
  const summary = data?.summary;
  const populationQuery = taskQueryString(filters, "population");
  const headingOf = (r: TaskRow) => `${T.heading(r)} — ${r.dealerName ?? r.description ?? ""}`.trim();
  const showTrail = async (r: TaskRow) => { const h = await api.get<TaskHistoryPayload>(`/api/tasks/history/${r.sourceType}/${encodeURIComponent(r.taskId)}`); showOn(r, h); };
  const showOn = (r: TaskRow, h: TaskHistoryPayload) => { setSelected({ key: r.key, label: headingOf(r), trail: h.trail }); if (!calendarOpen) { setCalendarOpen(true); writePref(true); } setPanel(null); };

  const sectionOptions = [["SALES", L.secSALES], ["RECOVERY", L.secRECOVERY], ["APPOINTMENT", L.secAPPOINTMENT], ["VISITS", L.secVISITS], ["OTHERS", L.secOTHERS]] as const;
  const sourceOptions = [["REGULAR", L.subREGULAR], ["SCHEME", L.subSCHEME], ["BILLING_EXCEPTION", L.subBILLING], ["CN_REQUEST", L.subCN]] as const;
  const statusOptions = [["COMPLETED", L.stCompleted], ["PENDING", L.stPending], ["OVERDUE", L.stOverdue], ["ABANDONED", L.stAbandoned], ["CANCELLED", L.stCancelled]] as const;
  const basisLabel = filters.basis === "ORIGINAL" ? L.bOriginal : filters.basis === "ABANDONED_ON" ? L.bAbandoned : L.bMoved;
  const note = (filters.basis === "ORIGINAL" ? L.noteOriginal : filters.basis === "ABANDONED_ON" ? L.noteAbandoned : L.noteMoved).replace("{from}", formatDMY(filters.from)).replace("{to}", formatDMY(filters.to));
  const stat = (label: string, value: string, id: string) => (<div key={id} data-testid={`stat-${id}`}><div className="text-xs text-muted-foreground">{label}</div><div className="text-lg font-semibold tabular-nums">{value}</div></div>);
  const colCount = 11;

  return (
    <div className="space-y-4" data-testid="task-analysis">
      {/* All | Auto | Manual */}
      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm" role="group" aria-label={`${L.all} / ${L.auto} / ${L.manual}`} data-testid="type-switch">
        {([["ALL", L.all], ["AUTO", L.auto], ["MANUAL", L.manual]] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={filters.type === value} onClick={() => set({ type: value })}
            className={cn("rounded px-3 py-1 font-medium", filters.type === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>{label}</button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5"><Label>{L.basis}</Label>
          <NativeSelect className="w-48" aria-label={L.basis} value={filters.basis} onChange={(e) => set({ basis: e.target.value as TaskFilterState["basis"], focusDate: null })} options={[{ value: "ORIGINAL", label: L.bOriginal }, { value: "RESCHEDULED_ON", label: L.bMoved }, { value: "ABANDONED_ON", label: L.bAbandoned }]} />
        </div>
        <div className="space-y-1.5"><Label>{L.from} · {basisLabel}</Label><DateInputDMY value={filters.from} onChange={(v) => v && set({ from: v, focusDate: null })} className="w-44" aria-label={`${L.from} (${basisLabel})`} /></div>
        <div className="space-y-1.5"><Label>{L.to} · {basisLabel}</Label><DateInputDMY value={filters.to} onChange={(v) => v && set({ to: v, focusDate: null })} className="w-44" aria-label={`${L.to} (${basisLabel})`} /></div>
        {isAdmin && (
          <div className="space-y-1.5"><Label>{L.state}</Label>
            <NativeSelect className="w-44" aria-label={L.state} value={filters.groupId} onChange={(e) => set({ groupId: e.target.value, officerId: "", focusDate: null })} options={[{ value: "", label: L.allStates }, ...(data?.states ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
          </div>
        )}
        {!isSO && (
          <div className="space-y-1.5"><Label>{L.employee}</Label>
            <NativeSelect className="w-52" aria-label={L.employee} value={filters.officerId} onChange={(e) => set({ officerId: e.target.value, focusDate: null })} options={[{ value: "", label: L.allEmployees }, ...(data?.officers ?? []).map((o) => ({ value: o.id, label: o.name }))]} />
          </div>
        )}
        <div className="space-y-1.5"><Label>{L.section}</Label><NativeSelect className="w-44" aria-label={L.section} value={filters.section} onChange={(e) => set({ section: e.target.value, focusDate: null })} options={[{ value: "", label: L.allSections }, ...sectionOptions.map(([value, label]) => ({ value, label }))]} /></div>
        <div className="space-y-1.5"><Label>{L.source}</Label><NativeSelect className="w-44" aria-label={L.source} value={filters.source} onChange={(e) => set({ source: e.target.value, focusDate: null })} options={[{ value: "", label: L.allSources }, ...sourceOptions.map(([value, label]) => ({ value, label }))]} /></div>
        <div className="space-y-1.5"><Label>{L.status}</Label><NativeSelect className="w-40" aria-label={L.status} value={filters.status} onChange={(e) => set({ status: e.target.value, focusDate: null })} options={[{ value: "", label: L.allStatuses }, ...statusOptions.map(([value, label]) => ({ value, label }))]} /></div>
      </div>
      {rangeBad ? <p role="alert" className="text-sm text-destructive">{L.range}</p> : <p className="text-sm text-muted-foreground" data-testid="basis-note"><Badge variant="secondary" className="mr-2">{basisLabel}</Badge>{note}</p>}

      <div className="grid gap-3 rounded-lg border bg-background p-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="task-summary">
        {stat(L.sTotal, summary ? String(summary.total) : "—", "total")}
        {stat(L.sDone, summary ? String(summary.completed) : "—", "completed")}
        {stat(L.sPending, summary ? String(summary.pending) : "—", "pending")}
        {stat(L.sOverdue, summary ? String(summary.overdue) : "—", "overdue")}
        {stat(L.sAbandoned, summary ? String(summary.abandoned) : "—", "abandoned")}
        {summary && summary.cancelled > 0 && stat(L.sCancelled, String(summary.cancelled), "cancelled")}
        {stat(L.sMovedTasks, summary ? String(summary.rescheduledTasks) : "—", "rescheduled-tasks")}
        {stat(L.sMoves, summary ? String(summary.totalReschedules) : "—", "total-reschedules")}
        {stat(L.sAvg, summary ? String(summary.averageReschedules) : "—", "average")}
        {summary && summary.incompleteHistory > 0 && <p className="col-span-full text-xs text-muted-foreground" data-testid="history-note">{L.historyNote.replace("{n}", String(summary.incompleteHistory)).split("{total}").join(String(summary.total))}</p>}
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={toggleCalendar} aria-expanded={calendarOpen} data-testid="calendar-toggle"><CalendarDays className="h-4 w-4" /> {calendarOpen ? L.calHide : L.calShow}</Button>
      </div>
      {calendarOpen && !rangeBad && (
        <RescheduleCalendar query={populationQuery} initialMonth={(selected?.trail[0] ?? filters.from).slice(0, 7)} focusDate={filters.focusDate} onFocusDate={(d) => onFilters({ ...filters, focusDate: d, page: 1 })} selected={selected} onClearSelection={() => setSelected(null)} />
      )}

      {filters.focusDate && data && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-accent/40 p-2 text-sm" data-testid="focus-banner">
          <span>{L.focusBanner.replace("{date}", formatDMY(filters.focusDate)).replace("{n}", String(data.focusCount ?? 0))}</span>
          <Button size="sm" variant="outline" onClick={() => onFilters({ ...filters, focusDate: null, page: 1 })}>{L.focusClear}</Button>
        </div>
      )}

      <div className="overflow-auto rounded-lg border bg-background">
        <Table numbered numberStart={(data ? (data.page - 1) * data.pageSize : 0) + 1}>
          <TableHeader>
            <TableRow>
              <Th labelKey="tasks.col.employee" /><Th labelKey="tasks.col.task" /><Th labelKey="tasks.col.detail" /><Th labelKey="tasks.col.planned" /><Th labelKey="tasks.col.original" /><Th labelKey="tasks.col.current" />
              <Th labelKey="tasks.col.reschedules" /><Th labelKey="tasks.col.days_moved" /><Th labelKey="tasks.col.status" /><Th labelKey="tasks.col.action" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={colCount}><Skeleton className="h-6 w-full" aria-label={L.loading} /></TableCell></TableRow>
              : error ? <TableRow><TableCell colSpan={colCount} className="py-8 text-center text-destructive" role="alert">{L.error}</TableCell></TableRow>
              : (data?.rows.length ?? 0) === 0 ? <TableRow><TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground" data-testid="tasks-empty">{L.empty}</TableCell></TableRow>
              : data!.rows.map((r) => (
                <TableRow key={r.key} data-task-key={r.key}>
                  <TableCell className="min-w-[10rem] font-medium">{employeeHeaderText(r.ownerName, r.territory, r.state)}</TableCell>
                  <TableCell className="whitespace-nowrap">{T.short(r)}</TableCell>
                  <TableCell className="min-w-[9rem]">{T.detail(r, (id, name) => <DealerName id={id} name={name} />)}{r.marketName ? ` · ${r.marketName}` : ""}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{r.amount != null ? formatCurrency(r.amount) : "—"}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{formatDMY(r.originalDate)}{!r.originalVerified && " *"}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{formatDMY(r.currentDate)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setPanel(r)} data-testid="reschedule-count">{T.moves(r)}</button>
                    {r.historyState !== "COMPLETE" && <Badge variant="warning" className="ml-1">{r.historyState === "PARTIAL" ? T.partialBadge : T.unavailableBadge}</Badge>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{T.daysMoved(r.daysMoved)}</TableCell>
                  <TableCell>
                    <Badge variant={T.statusVariant(r.status)} data-testid="status-badge">{T.status(r.status)}</Badge>
                    {r.status === "ABANDONED" && (r.abandonReasonCode || r.abandonReason) && <div className="mt-1 max-w-[16rem] whitespace-normal text-xs text-destructive" data-testid="abandon-summary" title={abandon.summary(r.abandonReasonCode, r.abandonReason)}>{abandon.summary(r.abandonReasonCode, r.abandonReason)}</div>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Button size="sm" variant="outline" onClick={() => setPanel(r)}>{L.history}</Button>
                    {r.moves > 0 && <Button size="sm" variant="ghost" onClick={() => void showTrail(r)}>{L.showOnCal}</Button>}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
      {data?.rows.some((r) => !r.originalVerified) && <p className="text-xs text-muted-foreground">{L.unverified}</p>}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-end gap-3 text-sm">
          <Button size="sm" variant="outline" disabled={data.page <= 1} onClick={() => onFilters({ ...filters, page: data.page - 1 })}>{L.prev}</Button>
          <span>{L.page.replace("{page}", String(data.page)).replace("{pages}", String(data.totalPages))}</span>
          <Button size="sm" variant="outline" disabled={data.page >= data.totalPages} onClick={() => onFilters({ ...filters, page: data.page + 1 })}>{L.next}</Button>
        </div>
      )}
      {panel && <TaskHistoryPanel row={panel} onClose={() => setPanel(null)} onShowOnCalendar={(h) => showOn(panel, h)} />}
    </div>
  );
}
