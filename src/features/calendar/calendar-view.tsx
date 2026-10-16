"use client";

import { useTaggedDealersFirst } from "@/features/dealers/dealer-table-ui";
import { formatDMY } from "@/lib/date-format";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { PartyLink } from "@/features/calendar/party-link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Pencil, Trash2, RefreshCw, StickyNote } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { useLabel } from "@/features/labels/label-ui";
import { type LabelKey } from "@/features/labels/labels";
import { dateKey, dayTotals, employeeHeaderText, groupDayByEmployee, orderedDayItems, taskSubtype, type ConversionEvent, type TaskSubtype, type TaskTypeKind, type ConversionStatus, type PartyAppointmentEvent } from "@/lib/calendar";
import { BillingTaskDetailDialog } from "@/features/daily-work/billing-task-ui";
import type { CalendarBillingTaskDto } from "@/features/daily-work/billing-task-visibility.server";
import type { CalendarPayload, CalendarNoteDto, CalendarEntryDto, CalendarEntryKind } from "@/features/calendar/calendar.server";

const STATUS_META: Record<ConversionStatus, { key: LabelKey; variant: "muted" | "secondary" | "default" | "success" | "warning" | "destructive" }> = {
  PLANNED: { key: "calendar.status.planned", variant: "muted" },
  SUBMITTED: { key: "calendar.status.submitted", variant: "secondary" },
  APPROVED: { key: "calendar.status.approved", variant: "default" },
  CONVERTED: { key: "calendar.status.converted", variant: "success" },
  ENROLLED: { key: "calendar.status.enrolled", variant: "success" },
  DECLINED: { key: "calendar.status.declined", variant: "destructive" },
  RETURNED: { key: "calendar.status.returned", variant: "default" },
  REJECTED: { key: "calendar.status.rejected", variant: "destructive" },
};

/** Static dot colours (literal classes so Tailwind keeps them). */
const DOT_CLASS: Record<ConversionStatus, string> = {
  PLANNED: "bg-muted-foreground", SUBMITTED: "bg-primary", APPROVED: "bg-primary", CONVERTED: "bg-success",
  ENROLLED: "bg-success", DECLINED: "bg-destructive", RETURNED: "bg-primary", REJECTED: "bg-destructive",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const keyFor = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const longDate = (dk: string) => formatDMY(dk);

function StatusBadge({ status, label }: { status: ConversionStatus; label: string }) {
  return <Badge variant={STATUS_META[status].variant}>{label}</Badge>;
}

/** Static dot colours per entry kind (literal classes so Tailwind keeps them). */
const ENTRY_DOT: Record<CalendarEntryKind, string> = { TASK: "bg-primary", MEETING: "bg-success", REMINDER: "bg-warning", OTHER: "bg-muted-foreground" };
/** The `L` property holding each kind's visible label. */
const KIND_LABEL_PROP: Record<CalendarEntryKind, string> = { TASK: "kindTask", MEETING: "kindMeeting", REMINDER: "kindReminder", OTHER: "kindOther" };

export function CalendarView({ role, partyPlanningEnabled = false }: { role: Role; userId: string; partyPlanningEnabled?: boolean }) {
  const searchParams = useSearchParams();
  const taggedFirst = useTaggedDealersFirst();
  const qc = useQueryClient();
  const today = new Date();
  const todayKey = dateKey(today)!;
  // A notification link opens the Calendar on a given day: /planning/calendar?date=YYYY-MM-DD (a real calendar date only; anything else is ignored).
  const linkedDate = useMemo(() => {
    const raw = searchParams?.get("date") ?? "";
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toISOString().slice(0, 10) === raw ? raw : null;
  }, [searchParams]);
  const [cursor, setCursor] = useState(linkedDate ? { year: Number(linkedDate.slice(0, 4)), month: Number(linkedDate.slice(5, 7)) } : { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 });
  const [officerId, setOfficerId] = useState("");
  const [groupId, setGroupId] = useState("");
  // Regional Manager: My Calendar (own) is the default; Team Calendar widens to the RM's existing team scope (server-enforced).
  const [view, setView] = useState<"mine" | "team">("mine");
  // ONE selected date drives both layouts (desktop right-hand panel, smartphone agenda): the same query, the same grouped data, nothing loaded twice.
  const [selected, setSelected] = useState<string | null>(linkedDate);
  // Smartphone: like a phone calendar, today is selected from the start. Desktop: the details panel stays blank until a day is clicked.
  useEffect(() => { if (!linkedDate && typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) setSelected(todayKey); }, [todayKey, linkedDate]);

  // Labels
  const L = {
    title: useLabel("calendar.title"),
    today: useLabel("calendar.today"),
    prev: useLabel("calendar.prev_month"),
    next: useLabel("calendar.next_month"),
    allOfficers: useLabel("calendar.all_officers"),
    conversion: useLabel("calendar.conversion"),
    note: useLabel("calendar.note"),
    addNote: useLabel("calendar.add_note"),
    editNote: useLabel("calendar.edit_note"),
    deleteNote: useLabel("calendar.delete_note"),
    saveNote: useLabel("calendar.save_note"),
    cancel: useLabel("calendar.cancel"),
    notePlaceholder: useLabel("calendar.note_placeholder"),
    dateChanged: useLabel("calendar.date_changed"),
    previousDate: useLabel("calendar.previous_date"),
    newDate: useLabel("calendar.new_date"),
    noEvents: useLabel("calendar.no_events"),
    selectedDay: useLabel("calendar.selected_day"),
    entryOne: useLabel("calendar.entry_count_one"), entryMany: useLabel("calendar.entry_count_many"),
    expandSection: useLabel("calendar.expand_employee"), collapseSection: useLabel("calendar.collapse_employee"),
    scheme: useLabel("calendar.scheme"),
    schemes: useLabel("calendar.schemes"),
    partyAppointment: useLabel("calendar.party_appointment"),
    market: useLabel("calendar.market"),
    myCalendar: useLabel("calendar.my_calendar"),
    teamCalendar: useLabel("calendar.team_calendar"),
    allStates: useLabel("calendar.all_states"),
    salesOfficer: useLabel("calendar.sales_officer"),
    addTask: useLabel("calendar.add_task"),
    addReminder: useLabel("calendar.add_reminder"),
    kindTask: useLabel("calendar.kind.task"),
    kindMeeting: useLabel("calendar.kind.meeting"),
    kindReminder: useLabel("calendar.kind.reminder"),
    kindOther: useLabel("calendar.kind.other"),
    addedBy: useLabel("calendar.added_by"),
    taskType: useLabel("calendar.task_type"),
    dealer: useLabel("calendar.dealer"),
    selectDealer: useLabel("calendar.select_dealer"),
    amount: useLabel("calendar.amount"),
    paymentMode: useLabel("calendar.payment_mode"),
    dealerName: useLabel("calendar.dealer_name"),
    marketName: useLabel("calendar.market_name"),
    dealerVisits: useLabel("calendar.dealer_visits"),
    newPartyVisits: useLabel("calendar.new_party_visits"),
    details: useLabel("calendar.details"),
    reminderPlaceholder: useLabel("calendar.reminder_placeholder"),
    taskDetailsPlaceholder: useLabel("calendar.task_details_placeholder"),
    save: useLabel("calendar.save"),
    delete: useLabel("calendar.delete"),
    inDailyWork: useLabel("calendar.in_daily_work"),
    billingTask: useLabel("daily_work.task_type.billing_exception"),
    colTaskType: useLabel("daily_work.col.task_type"), taskTypeAuto: useLabel("daily_work.task_type.auto"),
    colRecoveryType: useLabel("daily_work.col.recovery_type"), sourceBilling: useLabel("daily_work.recovery_source.billing_exception"),
    btScheduled: useLabel("calendar.billing_task.scheduled"),
    btOverdue: useLabel("calendar.billing_task.overdue"),
    btInDailyWork: useLabel("calendar.billing_task.in_daily_work"),
    btConfirmed: useLabel("calendar.billing_task.confirmed"),
    btRescheduled: useLabel("calendar.billing_task.rescheduled"),
    btScheduledDate: useLabel("calendar.billing_task.scheduled_date"),
    btDetails: useLabel("calendar.billing_task.details"),
    taskPastDate: useLabel("calendar.task_past_date"),
    noDealers: useLabel("calendar.no_dealers"),
    secSALES: useLabel("daily_work.section.sales"),
    secRECOVERY: useLabel("daily_work.section.recovery"),
    secAPPOINTMENT: useLabel("daily_work.section.appointment"),
    secVISITS: useLabel("daily_work.section.visits"),
    secOTHERS: useLabel("daily_work.section.others"),
    pmCHEQUE: useLabel("daily_work.payment_mode.cheque"),
    pmUPI: useLabel("daily_work.payment_mode.upi"),
    pmNEFT_RTGS: useLabel("daily_work.payment_mode.neft_rtgs"),
    pmCASH: useLabel("daily_work.payment_mode.cash"),
    headingManual: useLabel("calendar.heading.manual"), headingManualSub: useLabel("calendar.heading.manual_sub"),
    headingAuto: useLabel("calendar.heading.auto"), headingAutoSub: useLabel("calendar.heading.auto_sub"),
    subREGULAR: useLabel("calendar.subtype.regular"), subSCHEME: useLabel("calendar.subtype.scheme"), subBILLING_EXCEPTION: useLabel("calendar.subtype.billing_exception"), subCN_REQUEST: useLabel("calendar.subtype.cn_request"),
    schemeName: useLabel("calendar.scheme_name"), assignedBy: useLabel("calendar.assigned_by"), totals: useLabel("calendar.totals"),
    assignRecipient: useLabel("calendar.assign.recipient"), assignSelect: useLabel("calendar.assign.select_officer"), assignSearch: useLabel("calendar.assign.search"), assignEmpty: useLabel("calendar.assign.empty"),
    reminderFor: useLabel("calendar.assign.reminder_for"), myself: useLabel("calendar.assign.myself"), pickFirst: useLabel("calendar.assign.pick_first"),
  };

  const params = new URLSearchParams({ year: String(cursor.year), month: String(cursor.month) });
  if (officerId) params.set("officerId", officerId);
  if (groupId) params.set("groupId", groupId);
  if (role === Role.REGIONAL_MANAGER) params.set("view", view);
  const { data, isLoading } = useQuery<CalendarPayload>({
    queryKey: ["calendar", cursor.year, cursor.month, officerId, groupId, view],
    queryFn: () => api.get(`/api/calendar?${params.toString()}`),
  });

  const eventsByDate = useMemo(() => {
    const m = new Map<string, ConversionEvent[]>();
    for (const e of data?.events ?? []) { const a = m.get(e.dateKey) ?? []; a.push(e); m.set(e.dateKey, a); }
    return m;
  }, [data]);
  const notesByDate = useMemo(() => {
    const m = new Map<string, CalendarNoteDto[]>();
    for (const n of data?.notes ?? []) { const a = m.get(n.dateKey) ?? []; a.push(n); m.set(n.dateKey, a); }
    return m;
  }, [data]);
  const entriesByDate = useMemo(() => {
    const m = new Map<string, CalendarEntryDto[]>();
    for (const e of data?.entries ?? []) { const a = m.get(e.dateKey) ?? []; a.push(e); m.set(e.dateKey, a); }
    return m;
  }, [data]);
  const billingByDate = useMemo(() => {
    const m = new Map<string, CalendarBillingTaskDto[]>();
    for (const t of data?.billingTasks ?? []) { const a = m.get(t.dateKey) ?? []; a.push(t); m.set(t.dateKey, a); }
    return m;
  }, [data]);
  const partyEventsByDate = useMemo(() => {
    const m = new Map<string, PartyAppointmentEvent[]>();
    for (const e of data?.partyEvents ?? []) { const a = m.get(e.dateKey) ?? []; a.push(e); m.set(e.dateKey, a); }
    return m;
  }, [data]);

  // Month grid cells (Sunday-first), padded to whole weeks.
  const cells = useMemo(() => {
    const firstDow = new Date(Date.UTC(cursor.year, cursor.month - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month, 0)).getUTCDate();
    const out: (string | null)[] = [];
    for (let i = 0; i < firstDow; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(keyFor(cursor.year, cursor.month, d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cursor]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["calendar"] });
  const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
  const step = (delta: number) => {
    const m = cursor.month + delta;
    const next = { year: cursor.year + Math.floor((m - 1) / 12), month: ((m - 1 + 12) % 12) + 1 };
    setCursor(next);
    // Details must never be stale after navigation: the selected day only stays when it is inside the month now shown.
    // Phone: today (if that month) or the 1st, so the agenda always has a date; desktop: back to the blank panel.
    setSelected(isPhone() ? (next.year === today.getUTCFullYear() && next.month === today.getUTCMonth() + 1 ? todayKey : keyFor(next.year, next.month, 1)) : null);
  };
  const goToday = () => { setCursor({ year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 }); setSelected(todayKey); };

  const officers = (data?.officers ?? []).filter((o) => !groupId || o.groupId === groupId); // State narrows the Sales Officer list
  const states = data?.states ?? [];
  const canFilter = data?.canFilterOfficers ?? false;
  const groupByOfficer = canFilter && !officerId; // Admin/RM global view groups by officer

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: L.title }]}
        title={L.title}
        subtitle={role === Role.SALES_OFFICER ? "Your scheme conversion dates, tasks, meetings, reminders and notes." : "Scheme conversion dates, tasks, meetings, reminders and notes — yours and your team's."}
      />

      {/* Toolbar: month nav + Today + (Admin/RM) officer filter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => step(-1)} aria-label={L.prev}><ChevronLeft className="h-4 w-4" /></Button>
          <div className="min-w-[10rem] text-center text-sm font-semibold">{MONTHS[cursor.month - 1]} {cursor.year}</div>
          <Button variant="outline" size="sm" onClick={() => step(1)} aria-label={L.next}><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={goToday}>{L.today}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {role === Role.REGIONAL_MANAGER && (
            <div className="inline-flex rounded-md border bg-background p-0.5 text-sm" role="group" aria-label="Calendar view">
              {([["mine", L.myCalendar], ["team", L.teamCalendar]] as const).map(([value, label]) => (
                <button
                  key={value} type="button"
                  onClick={() => { setView(value); setOfficerId(""); setGroupId(""); }}
                  className={cn("rounded px-3 py-1 font-medium", view === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                >{label}</button>
              ))}
            </div>
          )}
          {canFilter && (
            <>
              <NativeSelect
                className="w-40" aria-label={L.allStates}
                value={groupId}
                onChange={(e) => { setGroupId(e.target.value); setOfficerId(""); }}
                options={[{ value: "", label: L.allStates }, ...states.map((st) => ({ value: st.id, label: st.name }))]}
              />
              <NativeSelect
                className="w-64" aria-label={L.salesOfficer}
                value={officerId}
                onChange={(e) => setOfficerId(e.target.value)}
                options={[{ value: "", label: L.allOfficers }, ...officers.map((o) => ({ value: o.id, label: `${o.name} — ${o.roleLabel}` }))]}
              />
            </>
          )}
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)] lg:items-start lg:gap-5">
      {/* Month grid — compact on the left (desktop); the same grid sits above the agenda on a phone, with dots instead of event strips. */}
      <div className="min-w-0 overflow-hidden rounded-lg border bg-background" data-testid="calendar-grid">
        <div className="grid grid-cols-7 border-b bg-muted/30 text-xs font-medium text-muted-foreground">
          {WEEKDAYS.map((w) => <div key={w} className="px-1 py-2 text-center">{w}</div>)}
        </div>
        {isLoading ? (
          <Skeleton className="h-[22rem] w-full" />
        ) : (
          <div className="grid grid-cols-7">
            {cells.map((dk, i) => {
              if (!dk) return <div key={i} className="min-h-[3.25rem] border-b border-r bg-muted/10 lg:min-h-[4.5rem] [&:nth-child(7n)]:border-r-0" />;
              const evs = taggedFirst(eventsByDate.get(dk) ?? [], (e) => e.dealerId);
              const partyEvs = partyEventsByDate.get(dk) ?? [];
              const notes = notesByDate.get(dk) ?? [];
              const dayEntries = entriesByDate.get(dk) ?? [];
              const dayBilling = billingByDate.get(dk) ?? [];
              const totalEvs = evs.length + partyEvs.length + dayEntries.length + dayBilling.length;
              const total = totalEvs + notes.length;
              const shownParty = partyEvs.slice(0, Math.max(0, 1 - evs.length));
              const shownBilling = dayBilling.slice(0, Math.max(0, 1 - evs.length - shownParty.length));
              const shownEntries = dayEntries.slice(0, Math.max(0, 1 - evs.length - shownParty.length - shownBilling.length));
              const isToday = dk === todayKey;
              const isSelected = dk === selected;
              // One small coloured dot per entry on the phone (the same entry-type colours as the desktop chips).
              const dots = [
                ...evs.map((e) => DOT_CLASS[e.status]), ...partyEvs.map(() => "bg-warning"), ...dayBilling.map((t) => (t.status === "OVERDUE" ? "bg-destructive" : "bg-purple-500")),
                ...dayEntries.map((e) => ENTRY_DOT[e.kind]), ...notes.map(() => "bg-warning"),
              ];
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelected(dk)}
                  aria-pressed={isSelected}
                  aria-label={`${longDate(dk)}${total > 0 ? ` — ${(total === 1 ? L.entryOne : L.entryMany).replace("{n}", String(total))}` : ""}`}
                  data-date={dk}
                  className={cn(
                    "min-h-[3.25rem] min-w-0 border-b border-r p-1 text-left align-top transition-colors hover:bg-accent/40 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-[4.5rem] lg:p-1.5 [&:nth-child(7n)]:border-r-0",
                    isToday && "bg-primary/5",
                    isSelected && "bg-accent ring-2 ring-inset ring-primary", // the SELECTED day: a ring, separate from today's filled number
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums", isToday && "bg-primary font-semibold text-primary-foreground")}>{Number(dk.slice(-2))}</span>
                    {notes.length > 0 && <StickyNote className="hidden h-3.5 w-3.5 text-warning lg:block" />}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-0.5 px-0.5 lg:hidden" data-testid="calendar-dots">
                    {dots.slice(0, 4).map((c, j) => <span key={j} className={cn("h-1.5 w-1.5 rounded-full", c)} />)}
                    {dots.length > 4 && <span className="text-[9px] leading-none text-muted-foreground">+{dots.length - 4}</span>}
                  </div>
                  <div className="mt-1 hidden space-y-0.5 lg:block">
                    {evs.slice(0, 1).map((e) => (
                      <div key={e.planId} className="flex items-center gap-1 truncate rounded bg-primary/10 px-1 py-0.5 text-[11px] leading-tight">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[e.status])} />
                        <span className="truncate">{groupByOfficer ? e.salesOfficerName : <DealerName id={e.dealerId} name={e.dealerName} />}</span>
                      </div>
                    ))}
                    {shownParty.map((e) => (
                      <div key={e.planId} className="flex items-center gap-1 truncate rounded bg-accent px-1 py-0.5 text-[11px] leading-tight">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                        <span className="truncate">{groupByOfficer ? e.salesOfficerName : e.partyName}</span>
                      </div>
                    ))}
                    {shownBilling.map((t) => (
                      <div key={t.id} data-testid="calendar-billing-chip" className="flex items-center gap-1 truncate rounded bg-purple-500/10 px-1 py-0.5 text-[11px] leading-tight">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.status === "OVERDUE" ? "bg-destructive" : "bg-purple-500")} />
                        <span className="truncate">{groupByOfficer ? `${t.ownerName} · ${L.billingTask}` : <DealerName id={t.dealerId} name={t.dealerName} />}</span>
                      </div>
                    ))}
                    {shownEntries.map((e) => (
                      <div key={e.id} className="flex items-center gap-1 truncate rounded bg-muted/60 px-1 py-0.5 text-[11px] leading-tight">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", ENTRY_DOT[e.kind])} />
                        <span className="truncate">{groupByOfficer ? `${e.ownerName} · ${(L as Record<string, string>)[KIND_LABEL_PROP[e.kind]]}` : (L as Record<string, string>)[KIND_LABEL_PROP[e.kind]]}</span>
                      </div>
                    ))}
                    {totalEvs > 1 && <div className="px-1 text-[11px] text-muted-foreground">+{totalEvs - 1} more</div>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected-day details: right of the grid on desktop (blank until a day is picked), the agenda below it on a phone. */}
      <div className="mt-4 min-w-0 lg:mt-0" data-testid="calendar-day-panel">
        {selected && (
          <DayDetails
            key={selected}
            dateKey={selected}
            title={longDate(selected)}
            events={taggedFirst(eventsByDate.get(selected) ?? [], (e) => e.dealerId)}
            partyEvents={partyEventsByDate.get(selected) ?? []}
            notes={notesByDate.get(selected) ?? []}
            entries={entriesByDate.get(selected) ?? []}
            billingTasks={billingByDate.get(selected) ?? []}
            payload={data}
            loading={isLoading}
            role={role}
            groupByOfficer={groupByOfficer}
            partyPlanningEnabled={partyPlanningEnabled}
            labels={L}
            onChanged={invalidate}
          />
        )}
      </div>
      </div>
    </div>
  );
}

type Labels = Record<string, string>;

/** "Manual Task - Recovery [Regular]" / "Auto Task - Recovery [Billing Exception]": the task type, the real section and the real subtype (none → no brackets), from the label templates. */
function taskHeading(L: Labels, type: TaskTypeKind, section: string, subtype: TaskSubtype): string {
  const sectionText = L[`sec${section}`] ?? section;
  const subText = subtype ? L[`sub${subtype}`] ?? "" : "";
  const template = type === "MANUAL" ? (subText ? L.headingManualSub : L.headingManual) : (subText ? L.headingAutoSub : L.headingAuto);
  return template.replace("{section}", sectionText).replace("{subtype}", subText);
}

/**
 * The selected day's details (the old date dialog's content, now inline). With several employees visible (Admin / RM team view) the day's entries are grouped by EMPLOYEE in
 * collapsible sections — "Name [Territory] State" + entry count, collapsed to start, several may stay open; a Sales Officer (or anyone viewing a single employee) sees the
 * entries directly. Inside each employee ONE numbered list (1, 2, 3… for the date) replaces the per-task boxes. Admin / RM also see the day's totals. Admin may add a Manual Task or
 * Reminder for a Sales Officer. Expanding / collapsing and picking a date only change the view; every entry keeps its own permitted actions.
 */
function DayDetails({ dateKey: dk, title, events, partyEvents, notes, entries, billingTasks, payload, loading, role, groupByOfficer, partyPlanningEnabled, labels: L, onChanged }: {
  partyPlanningEnabled: boolean; loading: boolean;
  dateKey: string; title: string; events: ConversionEvent[]; partyEvents: PartyAppointmentEvent[]; notes: CalendarNoteDto[]; entries: CalendarEntryDto[]; billingTasks: CalendarBillingTaskDto[];
  payload: CalendarPayload | undefined; role: Role; groupByOfficer: boolean; labels: Labels; onChanged: () => void;
}) {
  const [adding, setAdding] = useState<CalendarEntryKind | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set()); // expanded employees (several allowed); starts collapsed for every new date
  const people = useMemo(() => payload?.people ?? {}, [payload]);
  const canAssign = payload?.canAssign ?? false;
  const canTask = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER || canAssign;
  const isPast = dk < dateKey(new Date())!;
  const actions: { kind: CalendarEntryKind; label: string; disabled?: boolean; hint?: string }[] = [
    ...(canTask ? [{ kind: "TASK" as const, label: L.addTask, disabled: isPast, hint: isPast ? L.taskPastDate : undefined }] : []),
    { kind: "REMINDER", label: L.addReminder },
  ];
  const groups = useMemo(() => groupDayByEmployee({ events, partyEvents, billingTasks, entries, notes }), [events, partyEvents, billingTasks, entries, notes]);
  const total = groups.reduce((n, g) => n + g.count, 0);
  const totals = useMemo(() => dayTotals(groups, (id) => people[id]?.role), [groups, people]);
  const showTotals = role !== Role.SALES_OFFICER; // Admin and RM
  const countText = (n: number) => (n === 1 ? L.entryOne : L.entryMany).replace("{n}", String(n));
  const toggle = (id: string) => setOpen((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const list = (g: (typeof groups)[number]) => (
    <ol className="divide-y" data-testid="day-list">
      {orderedDayItems(g).map((it, i) => (
        <li key={`${it.type}:${it.id}`} className="flex gap-3 py-3 first:pt-0 last:pb-0" data-testid="day-item">
          <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-muted-foreground" data-testid="item-number">{i + 1}.</span>
          <div className="min-w-0 flex-1">
            {it.type === "event" && <ConversionItem e={it.data as ConversionEvent} labels={L} />}
            {it.type === "party" && <PartyAppointmentItem e={it.data as PartyAppointmentEvent} labels={L} linked={partyPlanningEnabled} />}
            {it.type === "billing" && <BillingTaskItem t={it.data as CalendarBillingTaskDto} labels={L} />}
            {(it.type === "task" || it.type === "entry") && <EntryItem e={it.data as CalendarEntryDto} labels={L} onChanged={onChanged} />}
            {it.type === "note" && <NoteItem n={it.data as CalendarNoteDto} labels={L} onChanged={onChanged} />}
          </div>
        </li>
      ))}
    </ol>
  );
  const accordion = groupByOfficer || groups.length > 1;
  return (
    <section className="space-y-4 rounded-lg border bg-background p-4 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto" aria-label={`${L.selectedDay} ${title}`} data-testid="calendar-day-details">
      <div className="space-y-1">
        <h2 className="text-base font-semibold" data-testid="selected-date">{title}</h2>
        {showTotals && !loading && <p className="text-sm text-muted-foreground" data-testid="day-totals">{L.totals.replace("{officers}", String(totals.officers)).replace("{tasks}", String(totals.tasks))}</p>}
      </div>
      {/* Two clear actions (Add Task for SO / RM / Admin, Add Reminder for all); each opens its own small form below. */}
      <div className="grid grid-cols-2 gap-2">
        {actions.map((a) => (
          <Button key={a.kind} variant={adding === a.kind ? "default" : "outline"} size="sm" className="min-h-9" disabled={a.disabled} title={a.hint} onClick={() => setAdding(adding === a.kind ? null : a.kind)}>
            <Plus className="h-4 w-4" /> {a.label}
          </Button>
        ))}
      </div>
      {canTask && isPast && <p className="text-xs text-muted-foreground" role="status">{L.taskPastDate}</p>}
      {adding && <AddEntryForm kind={adding} dateKey={dk} payload={payload} labels={L} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); onChanged(); }} />}

      {loading ? <Skeleton className="h-24 w-full" /> : total === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="day-empty">{L.noEvents}</p>
      ) : accordion ? (
        <div className="space-y-2" data-testid="employee-groups">
          {groups.map((g) => {
            const expanded = open.has(g.employeeId);
            const panelId = `emp-${dk}-${g.employeeId}`;
            const header = employeeHeaderText(g.employeeName, people[g.employeeId]?.territory, people[g.employeeId]?.state);
            return (
              <div key={g.employeeId} className="rounded-md border" data-employee-id={g.employeeId}>
                <button
                  type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => toggle(g.employeeId)}
                  aria-label={`${expanded ? L.collapseSection : L.expandSection} ${header}`}
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 break-words text-sm font-semibold" data-testid="employee-header">{header}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">{countText(g.count)}<ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden /></span>
                </button>
                {expanded && <div id={panelId} className="border-t p-3">{list(g)}</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <div data-testid="employee-groups-flat">{groups.map((g) => <div key={g.employeeId}>{list(g)}</div>)}</div>
      )}
    </section>
  );
}

const itemHeading = "text-sm font-semibold";

/** A scheduled Billing Exception recovery task — an AUTO task generated by a business workflow; a read-only view of the ONE task (the same row the Sales Officer sees in Daily Work). */
function BillingTaskItem({ t, labels: L }: { t: CalendarBillingTaskDto; labels: Labels }) {
  const [open, setOpen] = useState(false);
  const statusLabel = t.status === "IN_DAILY_WORK" ? L.btInDailyWork : t.status === "OVERDUE" ? L.btOverdue : L.btScheduled;
  return (
    <div data-testid="calendar-billing-task">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={itemHeading} data-testid="item-heading">{taskHeading(L, "AUTO", "RECOVERY", taskSubtype("RECOVERY", null, "BILLING_EXCEPTION"))}</span>
        <div className="flex items-center gap-1">
          {t.rescheduled && <Badge variant="muted">{L.btRescheduled}</Badge>}
          {t.confirmed && <Badge variant="success">{L.btConfirmed}</Badge>}
          <Badge variant={t.status === "OVERDUE" ? "destructive" : t.status === "IN_DAILY_WORK" ? "success" : "secondary"}>{statusLabel}</Badge>
        </div>
      </div>
      <div className="mt-0.5 text-sm"><span className="font-medium"><DealerName id={t.dealerId} name={t.dealerName} /> — {formatCurrency(t.amount)}</span></div>
      <div className="mt-1 flex justify-end"><Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{L.btDetails}</Button></div>
      {open && <BillingTaskDetailDialog id={t.id} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** One Calendar entry. A Daily Task is a MANUAL task (deliberately created by its owner or by an Admin) — also after it moves into Daily Work; a reminder / meeting / other keeps its own name. */
function EntryItem({ e, labels: L, onChanged }: { e: CalendarEntryDto; labels: Labels; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(e.text ?? "");
  const update = useMutation({ mutationFn: () => api.patch(`/api/calendar/entries/${e.id}`, { text: text.trim() }), onSuccess: () => { setEditing(false); onChanged(); }, onError: (err) => alert((err as Error).message) });
  const remove = useMutation({ mutationFn: () => api.del(`/api/calendar/entries/${e.id}`), onSuccess: onChanged, onError: (err) => alert((err as Error).message) });
  const t = e.task;
  const heading = t ? taskHeading(L, "MANUAL", t.section, taskSubtype(t.section, t.entryType, null)) : L[KIND_LABEL_PROP[e.kind]];
  return (
    <div data-testid={t ? "calendar-manual-task" : "calendar-entry"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={itemHeading} data-testid="item-heading">{heading}</span>
        <div className="flex items-center gap-1">
          {e.materialized && <Badge variant="success">{L.inDailyWork}</Badge>}
          {e.canEdit && !editing && <Button variant="ghost" size="sm" title={L.editNote} onClick={() => { setEditing(true); setText(e.text ?? ""); }}><Pencil className="h-3.5 w-3.5" /></Button>}
          {e.canDelete && <Button variant="ghost" size="sm" title={L.delete} onClick={() => remove.mutate()}><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      </div>
      {t ? (
        <div className="mt-0.5 space-y-0.5 text-sm">
          {t.dealerName && <div className="font-medium"><DealerName id={t.dealerId ?? ""} name={t.dealerName} />{t.amount != null ? ` — ${formatCurrency(t.amount)}` : ""}</div>}
          {t.entryType === "SCHEME" && t.schemeName && <div className="text-muted-foreground">{L.schemeName.replace("{name}", t.schemeName)}</div>}
          {t.paymentMode && <div className="text-muted-foreground">{L.paymentMode}: {L[`pm${t.paymentMode}`] ?? t.paymentMode}</div>}
          {t.typedDealerName && <div className="font-medium">{t.typedDealerName}{t.marketName ? ` · ${t.marketName}` : ""}</div>}
          {(t.dealerVisits != null || t.newPartyVisits != null) && <div>{L.dealerVisits}: {t.dealerVisits ?? 0} · {L.newPartyVisits}: {t.newPartyVisits ?? 0}</div>}
          {e.text && <p className="whitespace-pre-wrap">{e.text}</p>}
        </div>
      ) : editing ? (
        <div className="mt-1 space-y-2">
          <Textarea value={text} onChange={(ev) => setText(ev.target.value)} rows={3} maxLength={2000} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>{L.cancel}</Button>
            <Button size="sm" disabled={!text.trim() || update.isPending} onClick={() => update.mutate()}>{L.save}</Button>
          </div>
        </div>
      ) : (
        <p className="mt-0.5 whitespace-pre-wrap text-sm">{e.text}</p>
      )}
      {/* The employee is the accordion header; the creator is shown only when someone ELSE assigned this entry (an Admin). */}
      {e.assignedBy && <div className="mt-1 text-xs text-muted-foreground" data-testid="assigned-by">{L.assignedBy}: {e.assignedBy.name} ({e.assignedBy.roleLabel})</div>}
    </div>
  );
}

/** The form for one of the actions. A Daily Task reuses the Daily Work section fields; a reminder is a text box. Admin adds an SO/RM recipient selector (task: required; reminder: optional). */
function AddEntryForm({ kind, dateKey: dk, payload, labels: L, onCancel, onSaved }: {
  kind: CalendarEntryKind; dateKey: string; payload: CalendarPayload | undefined; labels: Labels; onCancel: () => void; onSaved: () => void;
}) {
  const sections = payload?.taskSections ?? [];
  const canAssign = payload?.canAssign ?? false;
  const [recipientId, setRecipientId] = useState(""); // Admin: the SO/RM the task / reminder is for ("" = personal reminder)
  const [section, setSection] = useState(sections[0] ?? "SALES");
  const [dealerId, setDealerId] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState("");
  const [dealerName, setDealerName] = useState("");
  const [marketName, setMarketName] = useState("");
  const [dealerVisits, setDealerVisits] = useState("");
  const [newPartyVisits, setNewPartyVisits] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const assigning = canAssign && recipientId !== "";
  const needsRecipient = canAssign && kind === "TASK"; // an Admin owns no Daily Work, so a task always needs an SO/RM recipient
  const officers = (payload?.officers ?? []).filter((o) => o.role === "SALES_OFFICER" || o.role === "REGIONAL_MANAGER");
  const recipientOptions = officers.map((o) => ({ value: o.id, label: employeeHeaderText(o.name, o.territory, o.state) })); // same-name officers stay distinguishable
  const dealerSection = section === "SALES" || section === "RECOVERY";
  // The dealer choices are the RECIPIENT's own (never the Admin's); an SO / RM uses their own list.
  const recipientDealerQuery = useQuery<{ id: string; name: string }[]>({
    queryKey: ["calendar", "recipient-dealers", recipientId],
    queryFn: () => api.get(`/api/calendar/recipient-dealers?ownerId=${encodeURIComponent(recipientId)}`),
    enabled: needsRecipient && recipientId !== "" && dealerSection,
  });
  const dealers = canAssign ? (recipientDealerQuery.data ?? []) : (payload?.myDealers ?? []);

  const body = () => kind !== "TASK" ? { kind, date: dk, text: text.trim(), ...(assigning ? { ownerId: recipientId } : {}) } : {
    kind, date: dk, section, ...(assigning ? { ownerId: recipientId } : {}),
    ...(dealerSection ? { dealerId, amount: amount === "" ? undefined : Number(amount), ...(section === "RECOVERY" && paymentMode ? { paymentMode } : {}) } : {}),
    ...(section === "APPOINTMENT" ? { dealerName: dealerName.trim(), marketName: marketName.trim() } : {}),
    ...(section === "VISITS" ? { dealerVisits: dealerVisits === "" ? 0 : Number(dealerVisits), newPartyVisits: newPartyVisits === "" ? 0 : Number(newPartyVisits) } : {}),
    ...(section === "OTHERS" ? { text: text.trim() } : {}),
  };
  const valid = (needsRecipient ? recipientId !== "" : true) && (kind !== "TASK" ? text.trim() !== ""
    : dealerSection ? dealerId !== "" && Number(amount) > 0
      : section === "APPOINTMENT" ? dealerName.trim() !== ""
        : section === "VISITS" ? Number(dealerVisits || 0) + Number(newPartyVisits || 0) > 0
          : text.trim() !== "");
  const save = useMutation({ mutationFn: () => api.post("/api/calendar/entries", body()), onSuccess: onSaved, onError: (e) => setError((e as Error).message) });
  const whole = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => { const v = e.target.value; if (v === "" || /^\d+$/.test(v)) set(v); };
  const placeholder = L.reminderPlaceholder;

  return (
    <div className="space-y-3 rounded-md border bg-card p-3">
      {canAssign && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{kind === "TASK" ? L.assignRecipient : L.reminderFor}</label>
          {kind === "REMINDER" && (
            <NativeSelect aria-label={L.reminderFor} value={recipientId} onChange={(e) => setRecipientId(e.target.value)} options={[{ value: "", label: L.myself }, ...recipientOptions]} />
          )}
          {kind === "TASK" && (
            <SearchableSelect ariaLabel={L.assignSearch} placeholder={L.assignSelect} emptyText={L.assignEmpty} value={recipientId} onChange={(v) => { setRecipientId(v); setDealerId(""); setError(null); }} options={recipientOptions} />
          )}
        </div>
      )}
      {kind === "TASK" ? (
        <>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{L.taskType}</label>
            <NativeSelect value={section} onChange={(e) => { setSection(e.target.value); setError(null); }} options={sections.map((x) => ({ value: x, label: L[`sec${x}`] ?? x }))} />
          </div>
          {dealerSection && (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{L.dealer}</label>
                <NativeSelect dealerOptions value={dealerId} onChange={(e) => setDealerId(e.target.value)} placeholder={needsRecipient && recipientId === "" ? L.pickFirst : dealers.length === 0 ? L.noDealers : L.selectDealer} options={dealers.map((d) => ({ value: d.id, label: d.name }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{L.amount}</label>
                <Input type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              {section === "RECOVERY" && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{L.paymentMode}</label>
                  <NativeSelect value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)} placeholder="—" options={(payload?.paymentModes ?? []).map((m) => ({ value: m, label: L[`pm${m}`] ?? m }))} />
                </div>
              )}
            </>
          )}
          {section === "APPOINTMENT" && (
            <>
              <Input placeholder={L.dealerName} value={dealerName} onChange={(e) => setDealerName(e.target.value)} maxLength={200} />
              <Input placeholder={L.marketName} value={marketName} onChange={(e) => setMarketName(e.target.value)} maxLength={200} />
            </>
          )}
          {section === "VISITS" && (
            <>
              <div className="space-y-1"><label className="text-xs font-medium text-muted-foreground">{L.dealerVisits}</label><Input inputMode="numeric" value={dealerVisits} onChange={whole(setDealerVisits)} placeholder="0" /></div>
              <div className="space-y-1"><label className="text-xs font-medium text-muted-foreground">{L.newPartyVisits}</label><Input inputMode="numeric" value={newPartyVisits} onChange={whole(setNewPartyVisits)} placeholder="0" /></div>
            </>
          )}
          {section === "OTHERS" && <Textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder={L.taskDetailsPlaceholder} />}
        </>
      ) : (
        <Textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} autoFocus />
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>{L.cancel}</Button>
        <Button size="sm" disabled={!valid || save.isPending} onClick={() => { setError(null); save.mutate(); }}>{L.save}</Button>
      </div>
    </div>
  );
}

/** Party Appointment detail — Party Name + Market. Links to Party Planning → View (read-only here). */
function PartyAppointmentItem({ e, labels: L, linked }: { e: PartyAppointmentEvent; labels: Labels; linked: boolean }) {
  return (
    <div>
      <span className={itemHeading} data-testid="item-heading">{L.partyAppointment}</span>
      <div><PartyLink enabled={linked} className="font-medium text-primary">{e.partyName}</PartyLink></div>
      {e.marketName && <div className="text-sm text-muted-foreground">{L.market}: {e.marketName}</div>}
    </div>
  );
}

function ConversionItem({ e, labels: L }: { e: ConversionEvent; labels: Labels }) {
  const schemesLabel = e.numberOfSchemes === 1 ? L.scheme : L.schemes;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={itemHeading} data-testid="item-heading">{L.conversion}</span>
        <StatusBadge status={e.status} label={L[STATUS_META[e.status].key] ?? e.status} />
      </div>
      {/* The authoritative edit lives in Scheme Planning; the item links there, it is not editable here. */}
      <Link href="/planning/scheme/plans" className="font-medium text-primary hover:underline"><DealerName id={e.dealerId} name={e.dealerName} /></Link>
      <div className="text-sm text-muted-foreground">{e.schemeName}</div>
      <div className="mt-1 text-sm">{e.numberOfSchemes} {schemesLabel} · {formatCurrency(e.totalSchemeAmount)}</div>
      {e.dateChanged && (
        <div className="mt-1 flex items-center gap-1 text-xs text-warning">
          <RefreshCw className="h-3 w-3" /> {L.dateChanged}
          {e.originalDateKey && <span className="text-muted-foreground"> · {L.previousDate}: {formatDMY(e.originalDateKey)} → {L.newDate}: {formatDMY(e.dateKey)}</span>}
        </div>
      )}
    </div>
  );
}

/** A note: existing notes keep working (view / edit / delete by their owner). */
function NoteItem({ n, labels: L, onChanged }: { n: CalendarNoteDto; labels: Labels; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const update = useMutation({ mutationFn: () => api.patch(`/api/calendar/notes/${n.id}`, { text: editText.trim() }), onSuccess: () => { setEditing(false); setEditText(""); onChanged(); }, onError: (e) => alert((e as Error).message) });
  const remove = useMutation({ mutationFn: () => api.del(`/api/calendar/notes/${n.id}`), onSuccess: onChanged, onError: (e) => alert((e as Error).message) });
  return (
    <div data-testid="calendar-note">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={itemHeading} data-testid="item-heading">{L.note}</span>
        {n.canEdit && !editing && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" title={L.editNote} onClick={() => { setEditing(true); setEditText(n.text); }}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="sm" title={L.deleteNote} onClick={() => remove.mutate()}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="mt-1 space-y-2">
          <Textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} maxLength={2000} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>{L.cancel}</Button>
            <Button size="sm" disabled={!editText.trim() || update.isPending} onClick={() => update.mutate()}>{L.saveNote}</Button>
          </div>
        </div>
      ) : (
        <p className="mt-0.5 whitespace-pre-wrap text-sm">{n.text}</p>
      )}
    </div>
  );
}
