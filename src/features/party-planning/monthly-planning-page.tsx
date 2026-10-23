"use client";

import { useState } from "react";
import { monthEndIso } from "@/lib/date-format";
import { DateInputDMY } from "@/components/ui/date-input-dmy";
import { formatDMY, formatDateTimeDMY } from "@/lib/date-format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Check, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { MAX_OPTIONS, TURNOVER_CATEGORIES, ROW_STATUS_LABEL, EMPTY_SENT_FORM, chooseSentAnswer, isLegacySentInfo, sentFormAnswered, sentFormBody, setSentNotSent, type SentForm, type Completeness, type PlanStage, type RowStatus, type StoredSentInfo } from "@/lib/monthly-plan";
import { fill, fillNodes, useLabels } from "./party-labels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import { SectionColgroup, type SectionTone } from "@/components/ui/table-group";
import { PlanDetailBar } from "./plan-detail-bar";
import { DealerDialog } from "@/features/sales-upload/create-dealer-dialog";

/* ------------------------------------------- DTOs (mirror monthly.server.ts) ------------------------------------------- */

interface EligiblePlan { id: string; marketName: string; marketPotential: string | null; type: string | null }
interface MonthlySheetDetail {
  sheet: { id: string; seasonName: string; seasonOpen: boolean; monthLabel: string; ownerName: string; status: string; own: boolean; counts: { create: number; submitted: number; approved: number; pendingRm: number; pendingAdmin: number; rejected: number }; submittedAt: string | null; rejectionStage: string | null; rejectionReason: string | null; canEdit: boolean; canSubmit: boolean; canReview: boolean };
  season: { id: string; name: string; year: number; period: string | null };
  month: { id: string; name: string; label: string; key: string };
  seasonalPlans: EligiblePlan[];
  plans: Plan[];
}
interface DocInfo { documents: boolean; checks: boolean; other: string | null }
interface StatusEvent { id: string; dealerId: string | null; previousStatus: string; newStatus: string; previousLabel: string; newLabel: string; actorName: string; actorRole: string; remarks: string | null; sentInfo: StoredSentInfo | null; receivedInfo: DocInfo | null; createdAt: string }
interface Option { id: string; optionNo: number; partyName: string | null; turnoverCategory: string | null }
interface DateChange { id: string; previousDate: string | null; newDate: string | null; byAdmin: boolean; automatic: boolean; actorName: string; actorRole: string; createdAt: string }
interface Plan {
  id: string; monthLabel: string; monthKey: string; ownerId: string; ownerGroupId: string | null; appointedDealerId: string | null; appointedDealerName: string | null; ownerName: string; marketName: string; marketPotential: string | null; planDate: string | null; canManage: boolean; options: Option[];
  opStatus: RowStatus; statusLabel: string; statusChangedAt: string | null; approvalStatus: string; canEditEntry: boolean; canReview: boolean; allowedStatuses: { to: RowStatus; label: string }[]; sentInfo: StoredSentInfo | null; receivedInfo: DocInfo | null; statusEvents: StatusEvent[];
  canEditDate: boolean; dateChangeCount: number; seasonalAddedOn: string; days: number; daysFinal: boolean; dateHistory: DateChange[];
}

const STATUS_VARIANT: Record<string, "muted" | "secondary" | "success" | "destructive" | "warning"> = {
  Draft: "muted", Submitted: "secondary", Approved: "secondary", Pending: "secondary", "Document Not Sent": "warning", "Doc Send By SO": "secondary", "Doc Received": "secondary", "SD Bounce": "warning", Appointed: "success", Rejected: "destructive",
};
const dash = <span className="text-muted-foreground">—</span>;
const dateText = (v: string | null) => (v ? formatDMY(v) : null);
const dateTimeText = (iso: string) => formatDateTimeDMY(iso);
const docText = (d: DocInfo | null, T: { document: string; check: string; otherValue: string }) => (d ? [d.documents && T.document, d.checks && T.check, d.other && fill(T.otherValue, { text: d.other })].filter(Boolean).join(" · ") || "—" : "—");

/** One-line text of what the owner answered (drawer): the new Complete / Incomplete answers, "Document Not Sent", or a legacy "sent" record shown as it was recorded. */
function sentText(d: StoredSentInfo | null, T: { item_document: string; item_cheque: string; complete: string; incomplete: string; notSentShort: string; legacyDoc: string; legacyCheque: string; legacySent: string; legacyNotSent: string; otherValue: string; legacyNote: string }): string {
  if (!d) return "—";
  const other = d.other ? fill(T.otherValue, { text: d.other }) : null;
  if (d.documentNotSent) return [T.notSentShort, other].filter(Boolean).join(" · ");
  if (isLegacySentInfo(d)) return [fill(T.legacyDoc, { value: d.documents ? T.legacySent : T.legacyNotSent }), fill(T.legacyCheque, { value: d.checks ? T.legacySent : T.legacyNotSent }), other, T.legacyNote].filter(Boolean).join(" · ");
  const c = (v: Completeness | null | undefined) => (v === "COMPLETE" ? T.complete : v === "INCOMPLETE" ? T.incomplete : "—");
  return [`${T.item_document}: ${c(d.documentStatus)}`, `${T.item_cheque}: ${c(d.chequeStatus)}`, other].filter(Boolean).join(" · ");
}

const SENT_TEXT_KEYS = {
  item_document: "party_planning.monthly.doc.item_document", item_cheque: "party_planning.monthly.doc.item_cheque", complete: "party_planning.monthly.doc.complete", incomplete: "party_planning.monthly.doc.incomplete",
  notSentShort: "party_planning.monthly.doc.not_sent_summary_short", legacyDoc: "party_planning.monthly.doc.legacy_doc", legacyCheque: "party_planning.monthly.doc.legacy_cheque", legacySent: "party_planning.monthly.doc.legacy_sent",
  legacyNotSent: "party_planning.monthly.doc.legacy_not_sent", otherValue: "party_planning.monthly.doc.other_value", legacyNote: "party_planning.monthly.doc.legacy_note",
} as const;

/** The status texts (display only). The server sends the stable English status text; the shown text is its editable label. */
const STATUS_KEYS = {
  "Draft": "party_planning.status.draft", "Submitted": "party_planning.status.submitted", "Approved": "party_planning.status.approved", "Pending": "party_planning.status.appointment_pending", "Document Not Sent": "party_planning.status.doc_not_sent", "Doc Send By SO": "party_planning.status.doc_sent",
  "Doc Received": "party_planning.status.doc_received", "SD Bounce": "party_planning.status.sd_bounce", "Appointed": "party_planning.status.appointed", "Rejected": "party_planning.status.rejected",
} as const;
function useStatusText(): (text: string) => string {
  const S = useLabels(STATUS_KEYS) as Record<string, string>;
  return (text) => S[text] ?? text;
}

/**
 * ONE Monthly Plan (a season month's market rows), opened by its id from the list. Season, month and rows are loaded from that plan — never
 * from the "current season / month". The market choices are the owner's APPROVED Seasonal Plan markets of this plan's season that are still free.
 */
export function MonthlyPlanDetailPage({ role, sheetId, stage = "create" }: { role: Role; sheetId: string; stage?: PlanStage }) {
  const qc = useQueryClient();
  const canPlan = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [drawerPlanId, setDrawerPlanId] = useState<string | null>(null);
  const [editOptionsId, setEditOptionsId] = useState<string | null>(null);
  const [statusPlanId, setStatusPlanId] = useState<string | null>(null);
  const [timelinePlanId, setTimelinePlanId] = useState<string | null>(null);
  const [historyPlanId, setHistoryPlanId] = useState<string | null>(null);
  const L = {
    title: useLabel("party_planning.title"), nav: useLabel("party_planning.nav.monthly"),
    market: useLabel("party_planning.monthly.col.market"), partyOptions: useLabel("party_planning.monthly.col.party_options"), days: useLabel("party_planning.monthly.col.days"),
    planDate: useLabel("party_planning.monthly.col.plan_date"),
    empty: useLabel("party_planning.monthly.empty"),
  };
  const tt = useTurnoverText();
  const T = useLabels({ editOptions: "party_planning.monthly.action.edit_options", editOptionsFor: "party_planning.monthly.aria.edit_options_for", back: "party_planning.nav.back", planning: "party_planning.crumb.planning", crumbCreate: "party_planning.crumb.create_new_plan", crumbView: "party_planning.crumb.view_plans", createView: "party_planning.crumb.create_view", crumbPlan: "party_planning.monthly.crumb_plan", returnedBy: "party_planning.monthly.msg.returned_by",
    closedNote: "party_planning.common.season_closed_note", status: "party_planning.monthly.col.status", history: "party_planning.common.history", partyOptionsFor: "party_planning.monthly.aria.party_options_for", changeStatus: "party_planning.monthly.aria.change_status",
    statusHistory: "party_planning.monthly.aria.status_history", daysFinal: "party_planning.monthly.tooltip.days_final", daysLive: "party_planning.monthly.tooltip.days_live", addMarket: "party_planning.action.add_market", submit: "party_planning.action.submit",
    approve: "party_planning.action.approve", reject: "party_planning.action.reject", emptySubmitted: "party_planning.monthly.empty_entries_submitted", emptyApproved: "party_planning.monthly.empty_entries_approved", emptyOlder: "party_planning.monthly.empty_entries_older" });
  const st = useStatusText();
  const { data: detail, isLoading, error: loadError } = useQuery<MonthlySheetDetail>({ queryKey: ["party-monthly-sheet", sheetId, stage], queryFn: () => api.get<MonthlySheetDetail>(`/api/party-monthly-sheets/${sheetId}?stage=${stage}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["party-monthly-sheet", sheetId] }); qc.invalidateQueries({ queryKey: ["party-monthly-sheets"] }); qc.invalidateQueries({ queryKey: ["party-monthly-sheet-options"] }); };
  const submit = useMutation({
    mutationFn: () => api.post(`/api/party-monthly-sheets/${sheetId}/submit`, {}),
    onSuccess: () => { setError(null); refresh(); }, onError: (e) => setError((e as Error).message),
  });
  const act = useMutation({
    mutationFn: (v: { action: "approve" | "reject"; reason?: string }) => api.post(`/api/party-monthly-sheets/${sheetId}/act`, v),
    onSuccess: () => { setError(null); setRejecting(false); refresh(); }, onError: (e) => setError((e as Error).message),
  });
  const sheet = detail?.sheet;
  const plans = detail?.plans ?? [];
  const statusPlan = statusPlanId ? detail?.plans.find((p) => p.id === statusPlanId) : undefined;
  const timelinePlan = timelinePlanId ? detail?.plans.find((p) => p.id === timelinePlanId) : undefined;
  const editOptionsPlan = editOptionsId ? detail?.plans.find((p) => p.id === editOptionsId) : undefined;
  const drawerPlan = drawerPlanId ? detail?.plans.find((p) => p.id === drawerPlanId) : undefined;
  const historyPlan = historyPlanId ? detail?.plans.find((p) => p.id === historyPlanId) : undefined;
  const canAdd = stage === "create" && canPlan && sheet?.own && sheet.canEdit; // the Create workspace: owner, season open — entries can be added at any time

  // Subtle Recovery-style column tints (shared SectionColgroup + tones): S.No and Market stay neutral. There is NO grouped heading row above the column headings; presentation only, column order unchanged.
  const sections: { span: number; tone: SectionTone }[] = [
    { span: 1, tone: "amber" }, // Party Options
    { span: 1, tone: "green" }, // Status
    { span: 2, tone: "blue" }, // Conversion Date + Days
  ];
  return (
    <div className="space-y-5">
      {/* Opened plan: compact Back + breadcrumbs only (the title, subtitle, mode switch and Seasonal | Monthly tabs stay on the lists). */}
      <PlanDetailBar crumbs={[{ label: T.planning }, { label: T.createView, href: "/planning/create" }, { label: L.title }, { label: L.nav, href: `/planning/party/monthly?stage=${stage}` }, { label: stage === "create" ? T.crumbCreate : T.crumbView, href: `/planning/party/monthly?stage=${stage}` }, { label: detail ? `${detail.season.name} ${detail.season.year} · ${detail.month.label}` : T.crumbPlan }]} backHref={`/planning/party/monthly?stage=${stage}`} backLabel={T.back} />

      {loadError && <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{(loadError as Error).message}</div>}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {sheet && (stage === "older" || (stage === "create" && sheet.rejectionReason)) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {stage === "create" && sheet.rejectionReason && <span className="text-destructive">{fill(T.returnedBy, { stage: sheet.rejectionStage, reason: sheet.rejectionReason })}</span>}
          {!sheet.seasonOpen && <span className="text-xs text-muted-foreground">{T.closedNote}</span>}
        </div>
      )}

      <div className="overflow-auto rounded-lg border bg-background">
        <Table numbered>
          <SectionColgroup leading={2} sections={sections} />
          <TableHeader>
            <TableRow><TableHead>{L.market}</TableHead><TableHead>{L.partyOptions}</TableHead><TableHead>{T.status}</TableHead><TableHead>{L.planDate}</TableHead><TableHead className="w-20 text-right">{L.days}</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : plans.length === 0 ? <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">{stage === "create" ? L.empty : stage === "older" ? T.emptyOlder : stage === "submitted" ? T.emptySubmitted : T.emptyApproved}</TableCell></TableRow>
                : plans.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.marketName}</TableCell>
                    <TableCell className="p-1">
                      <div className="flex items-start gap-1">
                      <button className="min-w-0 flex-1 rounded px-2 py-1 text-left hover:bg-muted" onClick={() => setDrawerPlanId(p.id)} aria-label={fill(T.partyOptionsFor, { market: p.marketName })}>
                        {p.options.map((o) => <div key={o.id} className="text-sm"><span className="text-muted-foreground">{o.optionNo}.</span> {o.partyName ?? dash}{o.partyName && <span className="text-muted-foreground"> · {turnoverShown(tt, o.turnoverCategory)}</span>}</div>)}
                      </button>
                      {p.canEditEntry && <Button type="button" size="sm" variant="ghost" aria-label={fill(T.editOptionsFor, { market: p.marketName })} title={T.editOptions} onClick={() => setEditOptionsId(p.id)}><Pencil className="h-4 w-4" /></Button>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {p.allowedStatuses.length > 0
                          ? <button type="button" className="rounded hover:opacity-80" aria-label={fill(T.changeStatus, { market: p.marketName })} onClick={() => setStatusPlanId(p.id)}><Badge variant={STATUS_VARIANT[p.statusLabel] ?? "muted"}>{st(p.statusLabel)} ▾</Badge></button>
                          : <Badge variant={STATUS_VARIANT[p.statusLabel] ?? "muted"}>{st(p.statusLabel)}</Badge>}
                        {p.statusEvents.length > 0 && <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => setTimelinePlanId(p.id)} aria-label={fill(T.statusHistory, { market: p.marketName })}>{T.history}</button>}
                      </div>
                    </TableCell>
                    <TableCell><ConversionDateCell plan={p} onChanged={refresh} onHistory={() => setHistoryPlanId(p.id)} /></TableCell>
                    <TableCell className="text-right tabular-nums" title={p.daysFinal ? T.daysFinal : T.daysLive}>{p.days}</TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
        {!isLoading && (canAdd || (stage === "create" && sheet?.canSubmit) || (stage === "submitted" && sheet?.canReview)) && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t p-2">
            <div>{canAdd && <Button variant="outline" size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {T.addMarket}</Button>}</div>
            <div className="flex gap-2">
              {stage === "create" && sheet?.canSubmit && <Button size="sm" disabled={submit.isPending} onClick={() => submit.mutate()}><Send className="h-4 w-4" /> {T.submit}</Button>}
              {stage === "submitted" && sheet?.canReview && <>
                <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ action: "approve" })}><Check className="h-4 w-4" /> {T.approve}</Button>
                <Button size="sm" variant="ghost" className="text-destructive" disabled={act.isPending} onClick={() => setRejecting(true)}><X className="h-4 w-4" /> {T.reject}</Button>
              </>}
            </div>
          </div>
        )}
      </div>
      {adding && detail && <AddMarketDialog sheetId={sheetId} detail={detail} labels={{ market: L.market, planDate: L.planDate }} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); refresh(); }} />}
      {rejecting && <RejectSheetDialog pending={act.isPending} error={error} onCancel={() => setRejecting(false)} onConfirm={(reason) => act.mutate({ action: "reject", reason })} />}
      {editOptionsPlan && <EditOptionsDialog plan={editOptionsPlan} onClose={() => setEditOptionsId(null)} onSaved={() => { setEditOptionsId(null); refresh(); }} />}
      {drawerPlan && <PartyOptionsDrawer plan={drawerPlan} onClose={() => setDrawerPlanId(null)} onShowTimeline={() => { setTimelinePlanId(drawerPlan.id); setDrawerPlanId(null); }} />}
      {statusPlan && <StatusDialog plan={statusPlan} onClose={() => setStatusPlanId(null)} onChanged={() => { setStatusPlanId(null); refresh(); }} />}
      {timelinePlan && <StatusTimelineDialog plan={timelinePlan} onClose={() => setTimelinePlanId(null)} />}
      {historyPlan && <DateHistoryDialog plan={historyPlan} onClose={() => setHistoryPlanId(null)} />}
    </div>
  );
}

/* ============================== Add Market dialog + plan-level reject ============================== */

/** Display wording for the stored turnover category codes (editable labels). The codes are what is saved and sent; the wording never is. */
function useTurnoverText() {
  const names: Record<string, string> = {
    LT_50L: useLabel("party_planning.monthly.turnover.LT_50L"), "50L_TO_1CR": useLabel("party_planning.monthly.turnover.50L_TO_1CR"), "1CR_TO_2CR": useLabel("party_planning.monthly.turnover.1CR_TO_2CR"),
    "2CR_TO_4CR": useLabel("party_planning.monthly.turnover.2CR_TO_4CR"), GT_4CR: useLabel("party_planning.monthly.turnover.GT_4CR"),
  };
  return { names, notRecorded: useLabel("party_planning.monthly.msg.turnover_not_recorded"), field: useLabel("party_planning.monthly.field.turnover"), placeholder: useLabel("party_planning.monthly.placeholder.select_turnover") };
}
/** "Not recorded" for a historical option whose turnover was never captured — never a guess. */
const turnoverShown = (tt: ReturnType<typeof useTurnoverText>, code: string | null): string => (code ? tt.names[code] ?? code : tt.notRecorded);

/* ------------------------------------------------ candidate party options (variable number, at least two complete) ------------------------------------------------ */

/** One editable option row. `key` is a stable React key (so removing a row keeps the others' typing); `id` = an already saved option. */
interface OptionRow { key: number; id?: string; party: string; turnover: string }
let optionRowSeq = 0;
const newOptionRow = (init: Partial<OptionRow> = {}): OptionRow => ({ key: ++optionRowSeq, party: "", turnover: "", ...init });
const startRows = (): OptionRow[] => [newOptionRow(), newOptionRow()];
const rowsPayload = (rows: OptionRow[]) => rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), partyName: r.party, turnoverCategory: r.turnover }));
/** Same rule as the server: every row present needs a party name and a turnover (a blank extra option must be completed or removed). Returns the first problem. */
function firstOptionProblem(rows: OptionRow[], msg: { party: string; turnover: string }): string | null {
  for (const [i, r] of rows.entries()) {
    if (!r.party.trim()) return fill(msg.party, { option: i + 1 });
    if (!r.turnover) return fill(msg.turnover, { option: i + 1 });
  }
  return null;
}

/** Party + its own Tentative Turnover per row, side by side (stacked on narrow screens), an Add Option button below, scrolling when there are many. */
function OptionRowsEditor({ rows, setRows, removableFrom, onChange }: { rows: OptionRow[]; setRows: (rows: OptionRow[]) => void; removableFrom: number; onChange: () => void }) {
  const tt = useTurnoverText();
  const T = useLabels({ party: "party_planning.monthly.field.option_party", add: "party_planning.monthly.action.add_option", remove: "party_planning.monthly.action.remove_option" });
  const patch = (key: number, change: Partial<OptionRow>) => { setRows(rows.map((r) => (r.key === key ? { ...r, ...change } : r))); onChange(); };
  return (
    <div className="space-y-2">
      <div className="max-h-[40vh] space-y-3 overflow-y-auto pr-1" data-testid="option-rows">
        {rows.map((r, i) => (
          <div key={r.key} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem_auto]" data-option-row={i + 1}>
            <div className="space-y-1.5"><Label>{fill(T.party, { n: i + 1 })} *</Label><Input maxLength={200} value={r.party} onChange={(e) => patch(r.key, { party: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>{tt.field} *</Label>
              <NativeSelect aria-label={`${fill(T.party, { n: i + 1 })} — ${tt.field}`} value={r.turnover} placeholder={tt.placeholder} options={TURNOVER_CATEGORIES.map((c) => ({ value: c, label: tt.names[c]! }))} onChange={(e) => patch(r.key, { turnover: e.target.value })} /></div>
            <div className="flex items-end">{rows.length > 2 && i >= removableFrom && <Button type="button" size="sm" variant="ghost" className="text-destructive" aria-label={fill(T.remove, { n: i + 1 })} title={fill(T.remove, { n: i + 1 })} onClick={() => { setRows(rows.filter((x) => x.key !== r.key)); onChange(); }}><Trash2 className="h-4 w-4" /></Button>}</div>
          </div>
        ))}
      </div>
      {rows.length < MAX_OPTIONS && <Button type="button" size="sm" variant="outline" onClick={() => { setRows([...rows, newOptionRow()]); onChange(); }}><Plus className="h-4 w-4" /> {T.add}</Button>}
    </div>
  );
}

/** Add one market row to THIS Monthly Plan: an approved Seasonal Plan market (never a new Market), Conversion Date and at least two complete party options. */
function AddMarketDialog({ sheetId, detail, labels, onClose, onAdded }: { sheetId: string; detail: MonthlySheetDetail; labels: { market: string; planDate: string }; onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ seasonalPlanId: "", planDate: "" });
  const [rows, setRows] = useState<OptionRow[]>(startRows);
  const [listOpen, setListOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const T = useLabels({ title: "party_planning.action.add_market", search: "party_planning.monthly.placeholder.search_market", none: "party_planning.monthly.placeholder.no_markets_left",
    notFound: "party_planning.monthly.empty_no_markets_found", partyRequired: "party_planning.monthly.error.option_party_required", turnoverRequired: "party_planning.monthly.error.turnover_required", cancel: "party_planning.common.cancel", add: "party_planning.common.add" });
  // A failed save keeps EVERY entered value (the dialog stays open); Add is disabled while a save is running.
  const add = useMutation({ mutationFn: () => api.post("/api/party-monthly-plans", { sheetId, ...form, options: rowsPayload(rows) }), onSuccess: onAdded, onError: (e) => setError((e as Error).message) });
  const marketOptions = detail.seasonalPlans.map((p) => ({ value: p.id, label: p.marketName }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" onEscapeKeyDown={(e) => { if (listOpen) e.preventDefault(); /* Escape closes the market list first */ }}>
        <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>{labels.market} *</Label>
            <SearchableSelect ariaLabel={labels.market} options={marketOptions} value={form.seasonalPlanId} onOpenChange={setListOpen}
              placeholder={detail.seasonalPlans.length ? T.search : T.none} emptyText={T.notFound} disabled={detail.seasonalPlans.length === 0}
              onChange={(id) => { setForm({ ...form, seasonalPlanId: id }); setError(null); }} />
          </div>
          <div className="space-y-1.5"><Label htmlFor="mp-plan-date">{labels.planDate}</Label>
            <DateInputDMY id="mp-plan-date" className="w-44" min={`${detail.month.key}-01`} max={monthEndIso(detail.month.key)} value={form.planDate} onChange={(v) => setForm({ ...form, planDate: v })} />
          </div>
          <OptionRowsEditor rows={rows} setRows={setRows} removableFrom={2} onChange={() => setError(null)} />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{T.cancel}</Button>
          <Button disabled={add.isPending || !form.seasonalPlanId} onClick={() => {
            const problem = firstOptionProblem(rows, { party: T.partyRequired, turnover: T.turnoverRequired });
            if (problem) { setError(problem); return; }
            add.mutate();
          }}>{T.add}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Correct the party options of an existing Draft / Rejected entry (older drafts with fewer than two complete options are brought up to the rule here). */
function EditOptionsDialog({ plan, onClose, onSaved }: { plan: Plan; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<OptionRow[]>(() => {
    const saved = plan.options.map((o) => newOptionRow({ id: o.id, party: o.partyName ?? "", turnover: o.turnoverCategory ?? "" }));
    while (saved.length < 2) saved.push(newOptionRow());
    return saved;
  });
  const [error, setError] = useState<string | null>(null);
  const T = useLabels({ title: "party_planning.monthly.dialog.edit_options_title", partyRequired: "party_planning.monthly.error.option_party_required", turnoverRequired: "party_planning.monthly.error.turnover_required", cancel: "party_planning.common.cancel", save: "party_planning.common.save" });
  const save = useMutation({ mutationFn: () => api.put(`/api/party-monthly-plans/${plan.id}`, { options: rowsPayload(rows) }), onSuccess: onSaved, onError: (e) => setError((e as Error).message) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{plan.marketName}</p>
        <OptionRowsEditor rows={rows} setRows={setRows} removableFrom={0} onChange={() => setError(null)} />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{T.cancel}</Button>
          <Button disabled={save.isPending} onClick={() => { const problem = firstOptionProblem(rows, { party: T.partyRequired, turnover: T.turnoverRequired }); if (problem) { setError(problem); return; } save.mutate(); }}>{T.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectSheetDialog({ pending, error, onCancel, onConfirm }: { pending: boolean; error: string | null; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const T = useLabels({ title: "party_planning.monthly.dialog.reject_title", reason: "party_planning.common.reason", cancel: "party_planning.common.cancel", reject: "party_planning.action.reject" });
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
        <div className="space-y-1.5"><Label>{T.reason} *</Label><Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />{error && <p className="text-sm text-destructive">{error}</p>}</div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{T.cancel}</Button>
          <Button variant="destructive" disabled={pending || !reason.trim()} onClick={() => onConfirm(reason)}>{T.reject}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================== Conversion Date, history and the Party Options drawer ============================== */

/**
 * The row's Conversion Date. Before the status workflow begins the SO (owner) edits it by hand → grey counter of those changes. Once the status
 * workflow has begun it is set automatically to the date of each status change and is no longer edited here. The counter opens the history.
 */
function ConversionDateCell({ plan, onChanged, onHistory }: { plan: Plan; onChanged: () => void; onHistory: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(plan.planDate ?? "");
  const [error, setError] = useState<string | null>(null);
  const T = useLabels({ planDate: "party_planning.monthly.col.plan_date", save: "party_planning.common.save", cancel: "party_planning.common.cancel", editDate: "party_planning.monthly.aria.edit_plan_date", setDate: "party_planning.monthly.action.set_date", changes: "party_planning.monthly.aria.date_changes" });
  const save = useMutation({
    mutationFn: () => api.put(`/api/party-monthly-plans/${plan.id}`, { planDate: value || null }),
    onSuccess: () => { setError(null); setEditing(false); onChanged(); },
    onError: (e) => setError((e as Error).message),
  });
  const monthStart = plan.monthKey ? `${plan.monthKey}-01` : undefined;
  if (editing) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <DateInputDMY className="w-40" aria-label={T.planDate} min={monthStart} max={plan.monthKey ? monthEndIso(plan.monthKey) : undefined} value={value} onChange={setValue} />
          <Button size="sm" className="shrink-0" disabled={save.isPending || value === (plan.planDate ?? "")} onClick={() => save.mutate()}>{T.save}</Button>
          <Button size="sm" variant="ghost" className="shrink-0" onClick={() => { setEditing(false); setError(null); }}>{T.cancel}</Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }
  const text = dateText(plan.planDate);
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      {plan.canEditDate
        ? <button type="button" className="rounded px-1 py-0.5 hover:bg-muted" aria-label={T.editDate} onClick={() => { setValue(plan.planDate ?? ""); setEditing(true); }}>{text ?? <span className="text-muted-foreground">{T.setDate}</span>}</button>
        : <span>{text ?? dash}</span>}
      {plan.dateChangeCount > 0 && (
        <button type="button" onClick={onHistory} className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground" aria-label={fill(T.changes, { count: plan.dateChangeCount })}>{plan.dateChangeCount}</button>
      )}
    </div>
  );
}

function DateHistoryDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const T = useLabels({ title: "party_planning.monthly.dialog.date_history_title", none: "party_planning.monthly.msg.no_changes", changedBy: "party_planning.monthly.msg.changed_by", auto: "party_planning.monthly.badge.status_change", admin: "party_planning.monthly.badge.admin", so: "party_planning.monthly.badge.sales_officer", close: "party_planning.common.close" });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{fill(T.title, { market: plan.marketName })}</DialogTitle></DialogHeader>
        <ol className="space-y-3 text-sm">
          {plan.dateHistory.length === 0 && <li className="text-muted-foreground">{T.none}</li>}
          {plan.dateHistory.map((c, i) => (
            <li key={c.id} className="rounded-md border p-3">
              <div className="font-medium">{i + 1}. {dateText(c.previousDate) ?? "—"} → {dateText(c.newDate) ?? "—"}</div>
              <div>{fill(T.changedBy, { name: c.actorName })} <Badge variant={c.automatic ? "secondary" : c.byAdmin ? "success" : "muted"} className="ml-1">{c.automatic ? T.auto : c.byAdmin ? T.admin : T.so}</Badge></div>
              <div className="text-xs text-muted-foreground">{dateTimeText(c.createdAt)}</div>
            </li>
          ))}
        </ol>
        <DialogFooter><Button variant="outline" onClick={onClose}>{T.close}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Right-side drawer: BOTH candidate parties (names only — they have no status of their own) and the row's single status with what was sent / received. */
function PartyOptionsDrawer({ plan, onClose, onShowTimeline }: { plan: Plan; onClose: () => void; onShowTimeline: () => void }) {
  const tt = useTurnoverText();
  const T = useLabels({ title: "party_planning.monthly.col.party_options", close: "party_planning.common.close", closeDrawer: "party_planning.monthly.aria.close_drawer", optN: "party_planning.monthly.col.option_n",
    partyName: "party_planning.monthly.field.party_name", status: "party_planning.monthly.col.status", since: "party_planning.monthly.msg.since", sent: "party_planning.monthly.msg.sent_by_so", received: "party_planning.monthly.msg.received_by_admin",
    dealerCreated: "party_planning.monthly.msg.dealer_created", viewHistory: "party_planning.monthly.action.view_status_history", document: "party_planning.monthly.doc.document", check: "party_planning.monthly.doc.check", otherValue: "party_planning.monthly.doc.other_value" });
  const st = useStatusText();
  const SL = useLabels(SENT_TEXT_KEYS);
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={T.title} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <button type="button" className="absolute inset-0 bg-black/30" aria-label={T.close} onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l bg-background p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div><h2 className="text-lg font-semibold">{T.title}</h2><p className="text-sm text-muted-foreground">{plan.marketName} · {plan.monthLabel}</p></div>
          <Button size="sm" variant="ghost" aria-label={T.closeDrawer} onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <div className="space-y-4 text-sm">
          {plan.options.map((o) => (
            <section key={o.id} className="rounded-md border p-3"><h3 className="font-semibold">{fill(T.optN, { n: o.optionNo })}</h3><div>{T.partyName}: <b>{o.partyName ?? "—"}</b></div>{o.partyName && <div>{tt.field}: <b>{turnoverShown(tt, o.turnoverCategory)}</b></div>}</section>
          ))}
          <section className="space-y-1.5 rounded-md border p-3">
            <h3 className="font-semibold">{T.status}</h3>
            <div className="flex items-center gap-2"><Badge variant={STATUS_VARIANT[plan.statusLabel] ?? "muted"}>{st(plan.statusLabel)}</Badge>{plan.statusChangedAt && <span className="text-xs text-muted-foreground">{fill(T.since, { date: dateTimeText(plan.statusChangedAt) })}</span>}</div>
            <div>{fill(T.sent, { value: sentText(plan.sentInfo, SL) })}</div>
            <div>{fill(T.received, { value: docText(plan.receivedInfo, T) })}</div>
            {plan.appointedDealerName && <div>{T.dealerCreated}: <b>{plan.appointedDealerName}</b></div>}
            {plan.statusEvents.length > 0 && <Button size="sm" variant="outline" onClick={onShowTimeline}>{T.viewHistory}</Button>}
          </section>
        </div>
      </aside>
    </div>
  );
}

/* ================================================= status change (row level) ================================================= */

function InfoBlock({ title, info, at, by }: { title: string; info: DocInfo | null; at?: string | null; by?: string | null }) {
  const T = useLabels({ sent: "party_planning.monthly.doc.document_sent", check: "party_planning.monthly.doc.check_send", other: "party_planning.monthly.doc.other", yes: "party_planning.monthly.doc.selected", no: "party_planning.monthly.doc.not_selected" });
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm">
      <div className="font-semibold">{title}</div>
      <div>{T.sent}: <b>{info?.documents ? T.yes : T.no}</b></div>
      <div>{T.check}: <b>{info?.checks ? T.yes : T.no}</b></div>
      <div>{T.other}: <b>{info?.other ?? "—"}</b></div>
      {(by || at) && <div className="text-xs text-muted-foreground">{by}{at && `, ${dateTimeText(at)}`}</div>}
    </div>
  );
}

/** What the owner answered on the "Doc Send By SO" form, as a block: Document / Cheque Complete or Incomplete, or "Appointed, Document Not Sent"; an old record keeps its original "sent" meaning with completeness unrecorded. */
function SentBlock({ title, info, at, by }: { title: string; info: StoredSentInfo | null; at?: string | null; by?: string | null }) {
  const T = useLabels({ item_document: "party_planning.monthly.doc.item_document", item_cheque: "party_planning.monthly.doc.item_cheque", complete: "party_planning.monthly.doc.complete", incomplete: "party_planning.monthly.doc.incomplete",
    notAnswered: "party_planning.monthly.doc.not_answered", notSent: "party_planning.monthly.doc.not_sent_summary", legacyNote: "party_planning.monthly.doc.legacy_note", other: "party_planning.monthly.doc.other" });
  if (info && isLegacySentInfo(info)) return <div className="space-y-1"><InfoBlock title={title} info={{ documents: !!info.documents, checks: !!info.checks, other: info.other ?? null }} at={at} by={by} /><p className="text-xs text-muted-foreground">{T.legacyNote}</p></div>;
  const c = (v: Completeness | null | undefined) => (v === "COMPLETE" ? T.complete : v === "INCOMPLETE" ? T.incomplete : T.notAnswered);
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="sent-block">
      <div className="font-semibold">{title}</div>
      {info?.documentNotSent ? <div data-testid="sent-not-sent">{T.notSent}</div> : <>
        <div>{T.item_document}: <b data-testid="sent-document">{c(info?.documentStatus)}</b></div>
        <div>{T.item_cheque}: <b data-testid="sent-cheque">{c(info?.chequeStatus)}</b></div>
      </>}
      <div>{T.other}: <b>{info?.other ?? "—"}</b></div>
      {(by || at) && <div className="text-xs text-muted-foreground">{by}{at && `, ${dateTimeText(at)}`}</div>}
    </div>
  );
}

/**
 * Change the row's ONE operational status. The SO's "Doc Send By SO" (≥ one of Document / Check, optional Other text) and Admin's "Doc Received"
 * (what was ACTUALLY received, shown beside — never merged with — what the SO said was sent) and the other Admin statuses (SD Bounce / Appointed /
 * Rejected, optional remarks) all go through a confirmation step; the server re-validates everything.
 */
/**
 * `submit` lets a host (Daily Work → Dealer Appointment) run the SAME dialog but hand the validated transition body to its own coordinated endpoint, so the monthly
 * transition and the host's own record are saved together; without it the dialog posts to the Monthly Planning status endpoint exactly as before.
 */
export function StatusDialog({ plan, onClose, onChanged, submit }: { plan: Plan; onClose: () => void; onChanged: () => void; submit?: (body: Record<string, unknown>) => Promise<unknown> }) {
  const [to, setTo] = useState<RowStatus | null>(plan.allowedStatuses.length === 1 ? plan.allowedStatuses[0]!.to : null);
  const [doc, setDoc] = useState({ documents: false, checks: false, other: "" }); // Admin's "actually received" (unchanged)
  const [remarks, setRemarks] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dealerOpen, setDealerOpen] = useState(to === "APPOINTED");
  // The owner's "Doc Send By SO" answers. Nothing is preselected: Document and Cheque each start unanswered (null).
  const [sent, setSent] = useState<SentForm>(EMPTY_SENT_FORM);
  const isSend = to === "DOC_SENT";
  const isDoc = isSend || to === "DOC_RECEIVED";
  const sentBody = sentFormBody(sent);
  const appointing = to === "APPOINTED";
  const save = useMutation({
    mutationFn: () => {
      const body = to === "DOC_SENT" ? { to, sent: sentBody } : to === "DOC_RECEIVED" ? { to, received: doc } : { to, remarks };
      return submit ? submit(body) : api.post(`/api/party-monthly-plans/${plan.id}/status`, body);
    },
    onSuccess: onChanged, onError: (e) => { setConfirming(false); setError((e as Error).message); },
  });
  const answered = sentFormAnswered(sent);
  const valid = to != null && (isSend ? answered : !isDoc || doc.documents || doc.checks);
  const label = to ? (isSend && sent.notSent ? ROW_STATUS_LABEL.DOC_NOT_SENT : ROW_STATUS_LABEL[to]) : "";
  const received = to === "DOC_RECEIVED";
  const T = useLabels({ dealerTitle: "party_planning.monthly.dialog.create_dealer_title", title: "party_planning.monthly.dialog.status_title", current: "party_planning.monthly.msg.current", bySo: "party_planning.monthly.doc.submitted_by_so",
    actuallyReceived: "party_planning.monthly.doc.actually_received", whatSending: "party_planning.monthly.doc.what_sending", docReceived: "party_planning.monthly.doc.document_received", docSent: "party_planning.monthly.doc.document_sent",
    checkReceived: "party_planning.monthly.doc.check_received", checkSend: "party_planning.monthly.doc.check_send", otherReceived: "party_planning.monthly.doc.other_received", otherOptional: "party_planning.monthly.doc.other_optional",
    selectSent: "party_planning.monthly.validation.select_one_sent", selectReceived: "party_planning.monthly.validation.select_one_received", remarksOptional: "party_planning.monthly.field.remarks_optional", confirmChange: "party_planning.monthly.msg.confirm_change",
    receivedShort: "party_planning.monthly.doc.actually_received_short", youSending: "party_planning.monthly.doc.you_are_sending", remarks: "party_planning.monthly.msg.remarks", today: "party_planning.monthly.msg.date_set_today",
    notSentSpecial: "party_planning.monthly.doc.not_sent_special", item: "party_planning.monthly.doc.item", itemDocument: "party_planning.monthly.doc.item_document", itemCheque: "party_planning.monthly.doc.item_cheque", complete: "party_planning.monthly.doc.complete", incomplete: "party_planning.monthly.doc.incomplete", otherDetails: "party_planning.monthly.doc.other_details_optional", selectCompleteIncomplete: "party_planning.monthly.validation.select_complete_incomplete",
    back: "party_planning.common.back", confirmStatus: "party_planning.monthly.action.confirm_status", saving: "party_planning.common.saving", cancel: "party_planning.common.cancel", continue: "party_planning.common.continue" });
  const st = useStatusText();
  return (
    <>
    {/* Appointed does NOT save by itself: it opens the existing Dealer Alias "Create Dealer" form; the row becomes Appointed only when the dealer was created (one transaction). Cancel / failure leave the row untouched. */}
    {dealerOpen && (
      <DealerDialog open onOpenChange={(o) => { if (!o) { setDealerOpen(false); setTo(null); } }} title={T.dealerTitle} allowAssignExisting={false}
        prefill={{ groupId: plan.ownerGroupId ?? undefined, officerId: plan.ownerId }}
        submitCreate={(body) => api.post(`/api/party-monthly-plans/${plan.id}/appoint`, { dealer: body })} onCreated={() => onChanged()} />
    )}
    <Dialog open={!dealerOpen} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{fill(T.title, { market: plan.marketName })}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">{T.current} <Badge variant={STATUS_VARIANT[plan.statusLabel] ?? "muted"}>{st(plan.statusLabel)}</Badge></div>
          {!confirming && (
            <>
              <div className="flex flex-wrap gap-2">{plan.allowedStatuses.map((a) => <Button key={a.to} size="sm" variant={to === a.to ? "default" : "outline"} onClick={() => { setTo(a.to); setError(null); if (a.to === "APPOINTED") setDealerOpen(true); /* straight to the Create Dealer form */ }}>{st(a.label)}</Button>)}</div>
              {received && <SentBlock title={T.bySo} info={plan.sentInfo} />}
              {received && (
                <div className="space-y-2 rounded-md border p-3">
                  <div className="font-semibold">{T.actuallyReceived}</div>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={doc.documents} onChange={(e) => setDoc({ ...doc, documents: e.target.checked })} /> {T.docReceived}</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={doc.checks} onChange={(e) => setDoc({ ...doc, checks: e.target.checked })} /> {T.checkReceived}</label>
                  <div className="space-y-1"><Label>{T.otherReceived}</Label><Textarea rows={2} maxLength={500} value={doc.other} onChange={(e) => setDoc({ ...doc, other: e.target.value })} /></div>
                  {!doc.documents && !doc.checks && <p className="text-xs text-muted-foreground">{T.selectReceived}</p>}
                </div>
              )}
              {isSend && (
                <div className="space-y-3 rounded-md border p-3" data-testid="sent-form">
                  <div className="font-semibold">{T.whatSending}</div>
                  {/* Checking this alone saves nothing: it clears + disables the four answers; the normal Continue / confirm / save flow still applies. */}
                  <label className="flex items-center gap-2 text-base font-medium">
                    <input type="checkbox" className="h-5 w-5" data-testid="not-sent-special" checked={sent.notSent} onChange={(e) => { setError(null); setSent(setSentNotSent(sent, e.target.checked)); }} /> {T.notSentSpecial}
                  </label>
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-muted-foreground"><th className="py-1 font-medium">{T.item}</th><th className="py-1 text-center font-medium">{T.complete}</th><th className="py-1 text-center font-medium">{T.incomplete}</th></tr></thead>
                    <tbody>
                      {([["documentStatus", T.itemDocument, "document"], ["chequeStatus", T.itemCheque, "cheque"]] as const).map(([field, name, id]) => (
                        <tr key={field}>
                          <td className="py-1">{name}</td>
                          {(["COMPLETE", "INCOMPLETE"] as const).map((value) => (
                            <td key={value} className="py-1 text-center">
                              <input type="checkbox" className="h-4 w-4" data-testid={`${id}-${value.toLowerCase()}`} aria-label={`${name}: ${value === "COMPLETE" ? T.complete : T.incomplete}`} disabled={sent.notSent}
                                checked={sent[field] === value} onChange={(e) => setSent(chooseSentAnswer(sent, field, value, e.target.checked))} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="space-y-1"><Label>{T.otherDetails}</Label><Textarea rows={2} maxLength={500} value={sent.other} onChange={(e) => setSent({ ...sent, other: e.target.value })} /></div>
                  {!answered && <p className="text-xs text-muted-foreground" data-testid="sent-hint">{T.selectCompleteIncomplete}</p>}
                </div>
              )}
              {to != null && !isDoc && !appointing && <div className="space-y-1"><Label>{T.remarksOptional}</Label><Textarea rows={2} maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>}
            </>
          )}
          {confirming && (
            <div className="space-y-2">
              <p>{fillNodes(T.confirmChange, { market: <b>{plan.marketName}</b>, from: <b>{st(plan.statusLabel)}</b>, to: <b>{st(label)}</b> })}</p>
              {received && <InfoBlock title={T.receivedShort} info={{ documents: doc.documents, checks: doc.checks, other: doc.other.trim() || null }} />}
              {isSend && <SentBlock title={T.youSending} info={{ documentStatus: sentBody.documentStatus, chequeStatus: sentBody.chequeStatus, documentNotSent: sent.notSent, other: sent.other.replace(/\s+/g, " ").trim() || null }} />}
              {!isDoc && remarks.trim() && <p>{fill(T.remarks, { text: remarks.trim() })}</p>}
              <p className="text-xs text-muted-foreground">{T.today}</p>
            </div>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          {confirming
            ? <><Button variant="outline" disabled={save.isPending} onClick={() => setConfirming(false)}>{T.back}</Button><Button variant={to === "REJECTED" ? "destructive" : "default"} disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? T.saving : fill(T.confirmStatus, { status: st(label) })}</Button></>
            : <><Button variant="outline" onClick={onClose}>{T.cancel}</Button><Button disabled={!valid || appointing} onClick={() => setConfirming(true)}>{T.continue}</Button></>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

export function StatusTimelineDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const T = useLabels({ title: "party_planning.monthly.dialog.status_history_title", bySo: "party_planning.monthly.doc.submitted_by_so", received: "party_planning.monthly.doc.actually_received_admin", remarks: "party_planning.monthly.msg.remarks",
    dealerCreated: "party_planning.monthly.msg.dealer_created", dealerCreatedName: "party_planning.monthly.msg.dealer_created_name", close: "party_planning.common.close" });
  const st = useStatusText();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{fill(T.title, { market: plan.marketName })}</DialogTitle></DialogHeader>
        <ol className="space-y-3 text-sm">
          {plan.statusEvents.map((e, i) => (
            <li key={e.id} className="space-y-1 rounded-md border p-3">
              <div className="font-medium">{i + 1}. {st(e.previousLabel)} → {st(e.newLabel)}</div>
              <div className="text-xs text-muted-foreground">{dateTimeText(e.createdAt)} · {e.actorName} ({e.actorRole.replace(/_/g, " ").toLowerCase()})</div>
              {e.sentInfo && <SentBlock title={T.bySo} info={e.sentInfo} />}
              {e.receivedInfo && <InfoBlock title={T.received} info={e.receivedInfo} />}
              {e.remarks && <div>{fill(T.remarks, { text: e.remarks })}</div>}
              {e.dealerId && <div>{plan.appointedDealerName ? fill(T.dealerCreatedName, { name: plan.appointedDealerName }) : T.dealerCreated}</div>}
            </li>
          ))}
        </ol>
        <DialogFooter><Button variant="outline" onClick={onClose}>{T.close}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
