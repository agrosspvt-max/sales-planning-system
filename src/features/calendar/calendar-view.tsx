"use client";

import { useTaggedDealersFirst } from "@/features/dealers/dealer-table-ui";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { ChevronLeft, ChevronRight, Plus, Pencil, Trash2, RefreshCw, StickyNote } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/layout/page-header";
import { useLabel } from "@/features/labels/label-ui";
import { type LabelKey } from "@/features/labels/labels";
import { dateKey, groupEventsByOfficer, type ConversionEvent, type ConversionStatus, type PartyAppointmentEvent } from "@/lib/calendar";
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
const longDate = (dk: string) => { const [y, m, d] = dk.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

function StatusBadge({ status, label }: { status: ConversionStatus; label: string }) {
  return <Badge variant={STATUS_META[status].variant}>{label}</Badge>;
}

/** Static dot colours per entry kind (literal classes so Tailwind keeps them). */
const ENTRY_DOT: Record<CalendarEntryKind, string> = { TASK: "bg-primary", MEETING: "bg-success", REMINDER: "bg-warning", OTHER: "bg-muted-foreground" };
/** The `L` property holding each kind's visible label. */
const KIND_LABEL_PROP: Record<CalendarEntryKind, string> = { TASK: "kindTask", MEETING: "kindMeeting", REMINDER: "kindReminder", OTHER: "kindOther" };

export function CalendarView({ role }: { role: Role; userId: string }) {
  const taggedFirst = useTaggedDealersFirst();
  const qc = useQueryClient();
  const today = new Date();
  const todayKey = dateKey(today)!;
  const [cursor, setCursor] = useState({ year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 });
  const [officerId, setOfficerId] = useState("");
  const [groupId, setGroupId] = useState("");
  // Regional Manager: My Calendar (own) is the default; Team Calendar widens to the RM's existing team scope (server-enforced).
  const [view, setView] = useState<"mine" | "team">("mine");
  const [openDate, setOpenDate] = useState<string | null>(null);

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
    scheme: useLabel("calendar.scheme"),
    schemes: useLabel("calendar.schemes"),
    partyAppointment: useLabel("calendar.party_appointment"),
    market: useLabel("calendar.market"),
    myCalendar: useLabel("calendar.my_calendar"),
    teamCalendar: useLabel("calendar.team_calendar"),
    allStates: useLabel("calendar.all_states"),
    salesOfficer: useLabel("calendar.sales_officer"),
    addTask: useLabel("calendar.add_task"),
    addMeeting: useLabel("calendar.add_meeting"),
    addReminder: useLabel("calendar.add_reminder"),
    addOther: useLabel("calendar.add_other"),
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
    meetingPlaceholder: useLabel("calendar.meeting_placeholder"),
    reminderPlaceholder: useLabel("calendar.reminder_placeholder"),
    otherPlaceholder: useLabel("calendar.other_placeholder"),
    taskDetailsPlaceholder: useLabel("calendar.task_details_placeholder"),
    save: useLabel("calendar.save"),
    delete: useLabel("calendar.delete"),
    inDailyWork: useLabel("calendar.in_daily_work"),
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
  const step = (delta: number) => setCursor((c) => { const m = c.month + delta; return { year: c.year + Math.floor((m - 1) / 12), month: ((m - 1 + 12) % 12) + 1 }; });
  const goToday = () => setCursor({ year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 });

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

      {/* Month grid */}
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="grid grid-cols-7 border-b bg-muted/30 text-xs font-medium text-muted-foreground">
          {WEEKDAYS.map((w) => <div key={w} className="px-2 py-2 text-center">{w}</div>)}
        </div>
        {isLoading ? (
          <Skeleton className="h-[28rem] w-full" />
        ) : (
          <div className="grid grid-cols-7">
            {cells.map((dk, i) => {
              if (!dk) return <div key={i} className="min-h-[5.5rem] border-b border-r bg-muted/10 last:border-r-0" />;
              const evs = taggedFirst(eventsByDate.get(dk) ?? [], (e) => e.dealerId);
              const partyEvs = partyEventsByDate.get(dk) ?? [];
              const notes = notesByDate.get(dk) ?? [];
              const dayEntries = entriesByDate.get(dk) ?? [];
              const totalEvs = evs.length + partyEvs.length + dayEntries.length;
              const shownParty = partyEvs.slice(0, Math.max(0, 2 - evs.length));
              const shownEntries = dayEntries.slice(0, Math.max(0, 2 - evs.length - shownParty.length));
              const isToday = dk === todayKey;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setOpenDate(dk)}
                  className={cn(
                    "min-h-[5.5rem] border-b border-r p-1.5 text-left align-top transition-colors hover:bg-accent/40 [&:nth-child(7n)]:border-r-0",
                    isToday && "bg-primary/5",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums", isToday && "bg-primary font-semibold text-primary-foreground")}>{Number(dk.slice(-2))}</span>
                    {notes.length > 0 && <StickyNote className="h-3.5 w-3.5 text-warning" />}
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {evs.slice(0, 2).map((e) => (
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
                    {shownEntries.map((e) => (
                      <div key={e.id} className="flex items-center gap-1 truncate rounded bg-muted/60 px-1 py-0.5 text-[11px] leading-tight">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", ENTRY_DOT[e.kind])} />
                        <span className="truncate">{groupByOfficer ? `${e.ownerName} · ${(L as Record<string, string>)[KIND_LABEL_PROP[e.kind]]}` : (L as Record<string, string>)[KIND_LABEL_PROP[e.kind]]}</span>
                      </div>
                    ))}
                    {totalEvs > 2 && <div className="px-1 text-[11px] text-muted-foreground">+{totalEvs - 2} more</div>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {openDate && (
        <DateDetailDialog
          dateKey={openDate}
          title={longDate(openDate)}
          events={taggedFirst(eventsByDate.get(openDate) ?? [], (e) => e.dealerId)}
          partyEvents={partyEventsByDate.get(openDate) ?? []}
          notes={notesByDate.get(openDate) ?? []}
          entries={entriesByDate.get(openDate) ?? []}
          payload={data}
          role={role}
          groupByOfficer={groupByOfficer}
          labels={L}
          onClose={() => setOpenDate(null)}
          onChanged={invalidate}
        />
      )}
    </div>
  );
}

type Labels = Record<string, string>;

function DateDetailDialog({ dateKey: dk, title, events, partyEvents, notes, entries, payload, role, groupByOfficer, labels: L, onClose, onChanged }: {
  dateKey: string; title: string; events: ConversionEvent[]; partyEvents: PartyAppointmentEvent[]; notes: CalendarNoteDto[]; entries: CalendarEntryDto[];
  payload: CalendarPayload | undefined; role: Role; groupByOfficer: boolean; labels: Labels; onClose: () => void; onChanged: () => void;
}) {
  const groups = groupByOfficer ? groupEventsByOfficer(events) : null;
  const partyGroups = groupByOfficer ? groupEventsByOfficer(partyEvents) : null;
  const [adding, setAdding] = useState<CalendarEntryKind | null>(null);
  const canTask = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const isPast = dk < dateKey(new Date())!;
  const actions: { kind: CalendarEntryKind; label: string; disabled?: boolean; hint?: string }[] = [
    ...(canTask ? [{ kind: "TASK" as const, label: L.addTask, disabled: isPast, hint: isPast ? L.taskPastDate : undefined }] : []),
    { kind: "MEETING", label: L.addMeeting }, { kind: "REMINDER", label: L.addReminder }, { kind: "OTHER", label: L.addOther },
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {/* Four clear actions; each opens its own small form below (no immediate text box). */}
          <div className="grid grid-cols-2 gap-2">
            {actions.map((a) => (
              <Button key={a.kind} variant={adding === a.kind ? "default" : "outline"} size="sm" disabled={a.disabled} title={a.hint} onClick={() => setAdding(adding === a.kind ? null : a.kind)}>
                <Plus className="h-4 w-4" /> {a.label}
              </Button>
            ))}
          </div>
          {adding && <AddEntryForm kind={adding} dateKey={dk} payload={payload} labels={L} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); onChanged(); }} />}

          {events.length === 0 && partyEvents.length === 0 && notes.length === 0 && entries.length === 0 && <p className="text-sm text-muted-foreground">{L.noEvents}</p>}

          {groups
            ? groups.map((g) => (
                <div key={g.salesOfficerId} className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.salesOfficerName}</div>
                  {g.events.map((e) => <ConversionCard key={e.planId} e={e} labels={L} />)}
                </div>
              ))
            : events.map((e) => <ConversionCard key={e.planId} e={e} labels={L} />)}

          {/* Party Appointment events — grouped by officer for the Admin/RM global view, flat otherwise. */}
          {partyGroups
            ? partyGroups.map((g) => (
                <div key={`party-${g.salesOfficerId}`} className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.salesOfficerName}</div>
                  {g.events.map((e) => <PartyAppointmentCard key={e.planId} e={e} labels={L} />)}
                </div>
              ))
            : partyEvents.map((e) => <PartyAppointmentCard key={e.planId} e={e} labels={L} />)}

          {entries.map((e) => <EntryCard key={e.id} e={e} labels={L} onChanged={onChanged} />)}

          {/* Existing notes keep working (view / edit / delete); new entries are added through the four actions above. */}
          <NotesSection dateKey={dk} notes={notes} labels={L} onChanged={onChanged} />
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>{L.cancel}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One Calendar entry: what it is, the details, and WHO ADDED IT (important in Team / Admin views). */
function EntryCard({ e, labels: L, onChanged }: { e: CalendarEntryDto; labels: Labels; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(e.text ?? "");
  const update = useMutation({ mutationFn: () => api.patch(`/api/calendar/entries/${e.id}`, { text: text.trim() }), onSuccess: () => { setEditing(false); onChanged(); }, onError: (err) => alert((err as Error).message) });
  const remove = useMutation({ mutationFn: () => api.del(`/api/calendar/entries/${e.id}`), onSuccess: onChanged, onError: (err) => alert((err as Error).message) });
  const t = e.task;
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span className={cn("h-2 w-2 rounded-full", ENTRY_DOT[e.kind])} />
          {L[KIND_LABEL_PROP[e.kind]]}{t ? ` — ${L[`sec${t.section}`] ?? t.section}` : ""}
        </span>
        <div className="flex items-center gap-1">
          {e.materialized && <Badge variant="success">{L.inDailyWork}</Badge>}
          {e.canEdit && !editing && <Button variant="ghost" size="sm" title={L.editNote} onClick={() => { setEditing(true); setText(e.text ?? ""); }}><Pencil className="h-3.5 w-3.5" /></Button>}
          {e.canDelete && <Button variant="ghost" size="sm" title={L.delete} onClick={() => remove.mutate()}><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      </div>
      {t ? (
        <div className="space-y-0.5 text-sm">
          {t.dealerName && <div className="font-medium"><DealerName id={t.dealerId ?? ""} name={t.dealerName} />{t.amount != null ? ` — ${formatCurrency(t.amount)}` : ""}</div>}
          {t.paymentMode && <div className="text-muted-foreground">{L.paymentMode}: {L[`pm${t.paymentMode}`] ?? t.paymentMode}</div>}
          {t.typedDealerName && <div className="font-medium">{t.typedDealerName}{t.marketName ? ` · ${t.marketName}` : ""}</div>}
          {(t.dealerVisits != null || t.newPartyVisits != null) && <div>{L.dealerVisits}: {t.dealerVisits ?? 0} · {L.newPartyVisits}: {t.newPartyVisits ?? 0}</div>}
          {e.text && <p className="whitespace-pre-wrap">{e.text}</p>}
        </div>
      ) : editing ? (
        <div className="space-y-2">
          <Textarea value={text} onChange={(ev) => setText(ev.target.value)} rows={3} maxLength={2000} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>{L.cancel}</Button>
            <Button size="sm" disabled={!text.trim() || update.isPending} onClick={() => update.mutate()}>{L.save}</Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm">{e.text}</p>
      )}
      <div className="mt-1 text-xs text-muted-foreground">{L.addedBy}: {e.ownerName} ({e.ownerRoleLabel}){e.ownerState ? ` · ${e.ownerState}` : ""}</div>
    </div>
  );
}

/** The form for one of the four actions. A Daily Task reuses the Daily Work section fields; the rest are a text box. */
function AddEntryForm({ kind, dateKey: dk, payload, labels: L, onCancel, onSaved }: {
  kind: CalendarEntryKind; dateKey: string; payload: CalendarPayload | undefined; labels: Labels; onCancel: () => void; onSaved: () => void;
}) {
  const sections = payload?.taskSections ?? [];
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
  const dealers = payload?.myDealers ?? [];

  const body = () => kind !== "TASK" ? { kind, date: dk, text: text.trim() } : {
    kind, date: dk, section,
    ...(section === "SALES" || section === "RECOVERY" ? { dealerId, amount: amount === "" ? undefined : Number(amount), ...(section === "RECOVERY" && paymentMode ? { paymentMode } : {}) } : {}),
    ...(section === "APPOINTMENT" ? { dealerName: dealerName.trim(), marketName: marketName.trim() } : {}),
    ...(section === "VISITS" ? { dealerVisits: dealerVisits === "" ? 0 : Number(dealerVisits), newPartyVisits: newPartyVisits === "" ? 0 : Number(newPartyVisits) } : {}),
    ...(section === "OTHERS" ? { text: text.trim() } : {}),
  };
  const valid = kind !== "TASK" ? text.trim() !== ""
    : section === "SALES" || section === "RECOVERY" ? dealerId !== "" && Number(amount) > 0
      : section === "APPOINTMENT" ? dealerName.trim() !== ""
        : section === "VISITS" ? Number(dealerVisits || 0) + Number(newPartyVisits || 0) > 0
          : text.trim() !== "";
  const save = useMutation({ mutationFn: () => api.post("/api/calendar/entries", body()), onSuccess: onSaved, onError: (e) => setError((e as Error).message) });
  const whole = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => { const v = e.target.value; if (v === "" || /^\d+$/.test(v)) set(v); };
  const placeholder = kind === "MEETING" ? L.meetingPlaceholder : kind === "REMINDER" ? L.reminderPlaceholder : L.otherPlaceholder;

  return (
    <div className="space-y-3 rounded-md border bg-card p-3">
      {kind === "TASK" ? (
        <>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{L.taskType}</label>
            <NativeSelect value={section} onChange={(e) => { setSection(e.target.value); setError(null); }} options={sections.map((x) => ({ value: x, label: L[`sec${x}`] ?? x }))} />
          </div>
          {(section === "SALES" || section === "RECOVERY") && (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{L.dealer}</label>
                <NativeSelect dealerOptions value={dealerId} onChange={(e) => setDealerId(e.target.value)} placeholder={dealers.length === 0 ? L.noDealers : L.selectDealer} options={dealers.map((d) => ({ value: d.id, label: d.name }))} />
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

/** Party Appointment detail card — Party Name + Market. Links to Party Planning → View (read-only here). */
function PartyAppointmentCard({ e, labels: L }: { e: PartyAppointmentEvent; labels: Labels }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{L.partyAppointment}</span>
      </div>
      <Link href="/planning/party/view" className="font-medium text-primary hover:underline">{e.partyName}</Link>
      {e.marketName && <div className="text-sm text-muted-foreground">{L.market}: {e.marketName}</div>}
    </div>
  );
}

function ConversionCard({ e, labels: L }: { e: ConversionEvent; labels: Labels }) {
  const schemesLabel = e.numberOfSchemes === 1 ? L.scheme : L.schemes;
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{L.conversion}</span>
        <StatusBadge status={e.status} label={L[STATUS_META[e.status].key] ?? e.status} />
      </div>
      {/* The authoritative edit lives in Scheme Planning; the card links there, it is not editable here. */}
      <Link href="/planning/scheme/plans" className="font-medium text-primary hover:underline"><DealerName id={e.dealerId} name={e.dealerName} /></Link>
      <div className="text-sm text-muted-foreground">{e.schemeName}</div>
      <div className="mt-1 text-sm">{e.numberOfSchemes} {schemesLabel} · {formatCurrency(e.totalSchemeAmount)}</div>
      {e.dateChanged && (
        <div className="mt-1 flex items-center gap-1 text-xs text-warning">
          <RefreshCw className="h-3 w-3" /> {L.dateChanged}
          {e.originalDateKey && <span className="text-muted-foreground"> · {L.previousDate}: {e.originalDateKey.split("-").reverse().join("/")} → {L.newDate}: {e.dateKey.split("-").reverse().join("/")}</span>}
        </div>
      )}
    </div>
  );
}

function NotesSection({ notes, labels: L, onChanged }: { dateKey: string; notes: CalendarNoteDto[]; labels: Labels; onChanged: () => void }) {
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const update = useMutation({ mutationFn: (v: { id: string }) => api.patch(`/api/calendar/notes/${v.id}`, { text: editText.trim() }), onSuccess: () => { setEditId(null); setEditText(""); onChanged(); }, onError: (e) => alert((e as Error).message) });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/calendar/notes/${id}`), onSuccess: onChanged, onError: (e) => alert((e as Error).message) });

  return (
    <div className="space-y-2 border-t pt-3">
      {notes.map((n) => (
        <div key={n.id} className="rounded-md border bg-card p-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{L.note}{!n.canEdit && n.ownerName ? ` · ${n.ownerName}` : ""}</span>
            {n.canEdit && editId !== n.id && (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" title={L.editNote} onClick={() => { setEditId(n.id); setEditText(n.text); }}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="sm" title={L.deleteNote} onClick={() => remove.mutate(n.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            )}
          </div>
          {editId === n.id ? (
            <div className="space-y-2">
              <Textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} maxLength={2000} />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditId(null)}>{L.cancel}</Button>
                <Button size="sm" disabled={!editText.trim() || update.isPending} onClick={() => update.mutate({ id: n.id })}>{L.saveNote}</Button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm">{n.text}</p>
          )}
        </div>
      ))}

    </div>
  );
}
