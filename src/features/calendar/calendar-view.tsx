"use client";

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
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/layout/page-header";
import { useLabel } from "@/features/labels/label-ui";
import { type LabelKey } from "@/features/labels/labels";
import { dateKey, groupEventsByOfficer, type ConversionEvent, type ConversionStatus } from "@/lib/calendar";
import type { CalendarPayload, CalendarNoteDto } from "@/features/calendar/calendar.server";

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

export function CalendarView({ role }: { role: Role; userId: string }) {
  const qc = useQueryClient();
  const today = new Date();
  const todayKey = dateKey(today)!;
  const [cursor, setCursor] = useState({ year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 });
  const [officerId, setOfficerId] = useState("");
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
  };

  const params = new URLSearchParams({ year: String(cursor.year), month: String(cursor.month) });
  if (officerId) params.set("officerId", officerId);
  const { data, isLoading } = useQuery<CalendarPayload>({
    queryKey: ["calendar", cursor.year, cursor.month, officerId],
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

  const officers = data?.officers ?? [];
  const canFilter = data?.canFilterOfficers ?? false;
  const groupByOfficer = canFilter && !officerId; // Admin/RM global view groups by officer

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: L.title }]}
        title={L.title}
        subtitle={role === Role.SALES_OFFICER ? "Your scheme conversion dates and personal notes." : "Team scheme conversion dates (by Sales Officer) and your notes."}
      />

      {/* Toolbar: month nav + Today + (Admin/RM) officer filter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => step(-1)} aria-label={L.prev}><ChevronLeft className="h-4 w-4" /></Button>
          <div className="min-w-[10rem] text-center text-sm font-semibold">{MONTHS[cursor.month - 1]} {cursor.year}</div>
          <Button variant="outline" size="sm" onClick={() => step(1)} aria-label={L.next}><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={goToday}>{L.today}</Button>
        </div>
        {canFilter && (
          <NativeSelect
            className="w-56"
            value={officerId}
            onChange={(e) => setOfficerId(e.target.value)}
            options={[{ value: "", label: L.allOfficers }, ...officers.map((o) => ({ value: o.id, label: o.name }))]}
          />
        )}
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
              const evs = eventsByDate.get(dk) ?? [];
              const notes = notesByDate.get(dk) ?? [];
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
                        <span className="truncate">{groupByOfficer ? e.salesOfficerName : e.dealerName}</span>
                      </div>
                    ))}
                    {evs.length > 2 && <div className="px-1 text-[11px] text-muted-foreground">+{evs.length - 2} more</div>}
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
          events={eventsByDate.get(openDate) ?? []}
          notes={notesByDate.get(openDate) ?? []}
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

function DateDetailDialog({ dateKey: dk, title, events, notes, groupByOfficer, labels: L, onClose, onChanged }: {
  dateKey: string; title: string; events: ConversionEvent[]; notes: CalendarNoteDto[];
  groupByOfficer: boolean; labels: Labels; onClose: () => void; onChanged: () => void;
}) {
  const groups = groupByOfficer ? groupEventsByOfficer(events) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {events.length === 0 && notes.length === 0 && <p className="text-sm text-muted-foreground">{L.noEvents}</p>}

          {groups
            ? groups.map((g) => (
                <div key={g.salesOfficerId} className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.salesOfficerName}</div>
                  {g.events.map((e) => <ConversionCard key={e.planId} e={e} labels={L} />)}
                </div>
              ))
            : events.map((e) => <ConversionCard key={e.planId} e={e} labels={L} />)}

          <NotesSection dateKey={dk} notes={notes} labels={L} onChanged={onChanged} />
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>{L.cancel}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
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
      <Link href="/planning/scheme/plans" className="font-medium text-primary hover:underline">{e.dealerName}</Link>
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

function NotesSection({ dateKey: dk, notes, labels: L, onChanged }: { dateKey: string; notes: CalendarNoteDto[]; labels: Labels; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const create = useMutation({ mutationFn: () => api.post("/api/calendar/notes", { date: dk, text: text.trim() }), onSuccess: () => { setAdding(false); setText(""); onChanged(); }, onError: (e) => alert((e as Error).message) });
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

      {adding ? (
        <div className="space-y-2 rounded-md border bg-card p-3">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} placeholder={L.notePlaceholder} autoFocus />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => { setAdding(false); setText(""); }}>{L.cancel}</Button>
            <Button size="sm" disabled={!text.trim() || create.isPending} onClick={() => create.mutate()}>{L.saveNote}</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {L.addNote}</Button>
      )}
    </div>
  );
}
