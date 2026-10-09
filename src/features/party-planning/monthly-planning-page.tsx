"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Check, Plus, Send, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { ROW_STATUS_LABEL, type PlanStage, type RowStatus } from "@/lib/monthly-plan";
import { fill, fillNodes, useLabels } from "./party-labels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import { PartyPlanModeLinks } from "./party-planning-page";
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
interface StatusEvent { id: string; dealerId: string | null; previousStatus: string; newStatus: string; previousLabel: string; newLabel: string; actorName: string; actorRole: string; remarks: string | null; sentInfo: DocInfo | null; receivedInfo: DocInfo | null; createdAt: string }
interface Option { id: string; optionNo: 1 | 2; partyName: string | null }
interface DateChange { id: string; previousDate: string | null; newDate: string | null; byAdmin: boolean; automatic: boolean; actorName: string; actorRole: string; createdAt: string }
interface Plan {
  id: string; monthLabel: string; monthKey: string; ownerId: string; ownerGroupId: string | null; appointedDealerId: string | null; appointedDealerName: string | null; ownerName: string; marketName: string; marketPotential: string | null; planDate: string | null; canManage: boolean; options: Option[];
  opStatus: RowStatus; statusLabel: string; statusChangedAt: string | null; approvalStatus: string; canEditEntry: boolean; canReview: boolean; allowedStatuses: { to: RowStatus; label: string }[]; sentInfo: DocInfo | null; receivedInfo: DocInfo | null; statusEvents: StatusEvent[];
  canEditDate: boolean; dateChangeCount: number; seasonalAddedOn: string; days: number; daysFinal: boolean; dateHistory: DateChange[];
}

const STATUS_VARIANT: Record<string, "muted" | "secondary" | "success" | "destructive" | "warning"> = {
  Draft: "muted", Submitted: "secondary", Approved: "secondary", "Doc Send By SO": "secondary", "Doc Received": "secondary", "SD Bounce": "warning", Appointed: "success", Rejected: "destructive",
};
const dash = <span className="text-muted-foreground">—</span>;
const dateText = (v: string | null) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString("en-IN", { dateStyle: "medium" }) : null);
const dateTimeText = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const docText = (d: DocInfo | null, T: { document: string; check: string; otherValue: string }) => (d ? [d.documents && T.document, d.checks && T.check, d.other && fill(T.otherValue, { text: d.other })].filter(Boolean).join(" · ") || "—" : "—");

/** The status texts (display only). The server sends the stable English status text; the shown text is its editable label. */
const STATUS_KEYS = {
  "Draft": "party_planning.status.draft", "Submitted": "party_planning.status.submitted", "Approved": "party_planning.status.approved", "Doc Send By SO": "party_planning.status.doc_sent",
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
  const [statusPlanId, setStatusPlanId] = useState<string | null>(null);
  const [timelinePlanId, setTimelinePlanId] = useState<string | null>(null);
  const [historyPlanId, setHistoryPlanId] = useState<string | null>(null);
  const L = {
    title: useLabel("party_planning.title"), nav: useLabel("party_planning.nav.monthly"),
    market: useLabel("party_planning.monthly.col.market"), partyOptions: useLabel("party_planning.monthly.col.party_options"), days: useLabel("party_planning.monthly.col.days"),
    planDate: useLabel("party_planning.monthly.col.plan_date"),
    empty: useLabel("party_planning.monthly.empty"),
  };
  const T = useLabels({ planning: "party_planning.crumb.planning", createView: "party_planning.crumb.create_view", crumbPlan: "party_planning.monthly.crumb_plan", subtitle: "party_planning.monthly.subtitle_detail", returnedBy: "party_planning.monthly.msg.returned_by",
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
  const drawerPlan = drawerPlanId ? detail?.plans.find((p) => p.id === drawerPlanId) : undefined;
  const historyPlan = historyPlanId ? detail?.plans.find((p) => p.id === historyPlanId) : undefined;
  const canAdd = stage === "create" && canPlan && sheet?.own && sheet.canEdit; // the Create workspace: owner, season open — entries can be added at any time

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: T.planning }, { label: T.createView, href: "/planning/create" }, { label: L.title }, { label: L.nav, href: "/planning/party/monthly" }, { label: detail ? `${detail.season.name} ${detail.season.year} · ${detail.month.label}` : T.crumbPlan }]} title={L.title}
        subtitle={T.subtitle} />
      <PartyPlanModeLinks mode="monthly" stage={stage} />

      {loadError && <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{(loadError as Error).message}</div>}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {sheet && (stage === "older" || (stage === "create" && sheet.rejectionReason)) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {stage === "create" && sheet.rejectionReason && <span className="text-destructive">{fill(T.returnedBy, { stage: sheet.rejectionStage, reason: sheet.rejectionReason })}</span>}
          {!sheet.seasonOpen && <span className="text-xs text-muted-foreground">{T.closedNote}</span>}
        </div>
      )}

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow><TableHead>{L.market}</TableHead><TableHead>{L.partyOptions}</TableHead><TableHead>{T.status}</TableHead><TableHead>{L.planDate}</TableHead><TableHead className="w-20 text-right">{L.days}</TableHead></TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : plans.length === 0 ? <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">{stage === "create" ? L.empty : stage === "older" ? T.emptyOlder : stage === "submitted" ? T.emptySubmitted : T.emptyApproved}</TableCell></TableRow>
                : plans.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.marketName}</TableCell>
                    <TableCell className="p-1">
                      <button className="w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => setDrawerPlanId(p.id)} aria-label={fill(T.partyOptionsFor, { market: p.marketName })}>
                        {p.options.map((o) => <div key={o.id} className="text-sm"><span className="text-muted-foreground">{o.optionNo}.</span> {o.partyName ?? dash}</div>)}
                      </button>
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
      {drawerPlan && <PartyOptionsDrawer plan={drawerPlan} onClose={() => setDrawerPlanId(null)} onShowTimeline={() => { setTimelinePlanId(drawerPlan.id); setDrawerPlanId(null); }} />}
      {statusPlan && <StatusDialog plan={statusPlan} onClose={() => setStatusPlanId(null)} onChanged={() => { setStatusPlanId(null); refresh(); }} />}
      {timelinePlan && <StatusTimelineDialog plan={timelinePlan} onClose={() => setTimelinePlanId(null)} />}
      {historyPlan && <DateHistoryDialog plan={historyPlan} onClose={() => setHistoryPlanId(null)} />}
    </div>
  );
}

/* ============================== Add Market dialog + plan-level reject ============================== */

/** Add one market row to THIS Monthly Plan: an approved Seasonal Plan market (never a new Market), Conversion Date, Option 1 (required) and Option 2. */
function AddMarketDialog({ sheetId, detail, labels, onClose, onAdded }: { sheetId: string; detail: MonthlySheetDetail; labels: { market: string; planDate: string }; onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ seasonalPlanId: "", planDate: "", option1Party: "", option2Party: "" });
  const [listOpen, setListOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const T = useLabels({ title: "party_planning.action.add_market", opt1: "party_planning.monthly.field.option1_party", opt2: "party_planning.monthly.field.option2_party", search: "party_planning.monthly.placeholder.search_market", none: "party_planning.monthly.placeholder.no_markets_left",
    notFound: "party_planning.monthly.empty_no_markets_found", cancel: "party_planning.common.cancel", add: "party_planning.common.add" });
  const add = useMutation({ mutationFn: () => api.post("/api/party-monthly-plans", { sheetId, ...form }), onSuccess: onAdded, onError: (e) => setError((e as Error).message) });
  const marketOptions = detail.seasonalPlans.map((p) => ({ value: p.id, label: p.marketName }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" onEscapeKeyDown={(e) => { if (listOpen) e.preventDefault(); /* Escape closes the market list first */ }}>
        <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>{labels.market} *</Label>
            <SearchableSelect ariaLabel={labels.market} options={marketOptions} value={form.seasonalPlanId} onOpenChange={setListOpen}
              placeholder={detail.seasonalPlans.length ? T.search : T.none} emptyText={T.notFound} disabled={detail.seasonalPlans.length === 0}
              onChange={(id) => { setForm({ ...form, seasonalPlanId: id }); setError(null); }} />
          </div>
          <div className="space-y-1.5"><Label>{labels.planDate}</Label>
            <Input type="date" className="w-44" min={`${detail.month.key}-01`} max={`${detail.month.key}-31`} value={form.planDate} onChange={(e) => setForm({ ...form, planDate: e.target.value })} />
          </div>
          <div className="space-y-1.5"><Label>{T.opt1} *</Label><Input maxLength={200} value={form.option1Party} onChange={(e) => setForm({ ...form, option1Party: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>{T.opt2}</Label><Input maxLength={200} value={form.option2Party} onChange={(e) => setForm({ ...form, option2Party: e.target.value })} /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{T.cancel}</Button>
          <Button disabled={add.isPending || !form.seasonalPlanId || !form.option1Party.trim()} onClick={() => add.mutate()}>{T.add}</Button>
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
          <Input type="date" className="h-8 w-40" aria-label={T.planDate} min={monthStart} max={plan.monthKey ? `${plan.monthKey}-31` : undefined} value={value} onChange={(e) => setValue(e.target.value)} />
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
  const T = useLabels({ title: "party_planning.monthly.col.party_options", close: "party_planning.common.close", closeDrawer: "party_planning.monthly.aria.close_drawer", opt1: "party_planning.monthly.col.option1", opt2: "party_planning.monthly.col.option2",
    partyName: "party_planning.monthly.field.party_name", status: "party_planning.monthly.col.status", since: "party_planning.monthly.msg.since", sent: "party_planning.monthly.msg.sent_by_so", received: "party_planning.monthly.msg.received_by_admin",
    dealerCreated: "party_planning.monthly.msg.dealer_created", viewHistory: "party_planning.monthly.action.view_status_history", document: "party_planning.monthly.doc.document", check: "party_planning.monthly.doc.check", otherValue: "party_planning.monthly.doc.other_value" });
  const st = useStatusText();
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
            <section key={o.id} className="rounded-md border p-3"><h3 className="font-semibold">{o.optionNo === 1 ? T.opt1 : T.opt2}</h3><div>{T.partyName}: <b>{o.partyName ?? "—"}</b></div></section>
          ))}
          <section className="space-y-1.5 rounded-md border p-3">
            <h3 className="font-semibold">{T.status}</h3>
            <div className="flex items-center gap-2"><Badge variant={STATUS_VARIANT[plan.statusLabel] ?? "muted"}>{st(plan.statusLabel)}</Badge>{plan.statusChangedAt && <span className="text-xs text-muted-foreground">{fill(T.since, { date: dateTimeText(plan.statusChangedAt) })}</span>}</div>
            <div>{fill(T.sent, { value: docText(plan.sentInfo, T) })}</div>
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

/**
 * Change the row's ONE operational status. The SO's "Doc Send By SO" (≥ one of Document / Check, optional Other text) and Admin's "Doc Received"
 * (what was ACTUALLY received, shown beside — never merged with — what the SO said was sent) and the other Admin statuses (SD Bounce / Appointed /
 * Rejected, optional remarks) all go through a confirmation step; the server re-validates everything.
 */
export function StatusDialog({ plan, onClose, onChanged }: { plan: Plan; onClose: () => void; onChanged: () => void }) {
  const [to, setTo] = useState<RowStatus | null>(plan.allowedStatuses.length === 1 ? plan.allowedStatuses[0]!.to : null);
  const [doc, setDoc] = useState({ documents: false, checks: false, other: "" });
  const [remarks, setRemarks] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dealerOpen, setDealerOpen] = useState(to === "APPOINTED");
  const isDoc = to === "DOC_SENT" || to === "DOC_RECEIVED";
  const appointing = to === "APPOINTED";
  const save = useMutation({
    mutationFn: () => api.post(`/api/party-monthly-plans/${plan.id}/status`, to === "DOC_SENT" ? { to, sent: doc } : to === "DOC_RECEIVED" ? { to, received: doc } : { to, remarks }),
    onSuccess: onChanged, onError: (e) => { setConfirming(false); setError((e as Error).message); },
  });
  const valid = to != null && (!isDoc || doc.documents || doc.checks);
  const label = to ? ROW_STATUS_LABEL[to] : "";
  const received = to === "DOC_RECEIVED";
  const T = useLabels({ dealerTitle: "party_planning.monthly.dialog.create_dealer_title", title: "party_planning.monthly.dialog.status_title", current: "party_planning.monthly.msg.current", bySo: "party_planning.monthly.doc.submitted_by_so",
    actuallyReceived: "party_planning.monthly.doc.actually_received", whatSending: "party_planning.monthly.doc.what_sending", docReceived: "party_planning.monthly.doc.document_received", docSent: "party_planning.monthly.doc.document_sent",
    checkReceived: "party_planning.monthly.doc.check_received", checkSend: "party_planning.monthly.doc.check_send", otherReceived: "party_planning.monthly.doc.other_received", otherOptional: "party_planning.monthly.doc.other_optional",
    selectSent: "party_planning.monthly.validation.select_one_sent", selectReceived: "party_planning.monthly.validation.select_one_received", remarksOptional: "party_planning.monthly.field.remarks_optional", confirmChange: "party_planning.monthly.msg.confirm_change",
    receivedShort: "party_planning.monthly.doc.actually_received_short", youSending: "party_planning.monthly.doc.you_are_sending", remarks: "party_planning.monthly.msg.remarks", today: "party_planning.monthly.msg.date_set_today",
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
              {received && <InfoBlock title={T.bySo} info={plan.sentInfo} />}
              {isDoc && (
                <div className="space-y-2 rounded-md border p-3">
                  <div className="font-semibold">{received ? T.actuallyReceived : T.whatSending}</div>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={doc.documents} onChange={(e) => setDoc({ ...doc, documents: e.target.checked })} /> {received ? T.docReceived : T.docSent}</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={doc.checks} onChange={(e) => setDoc({ ...doc, checks: e.target.checked })} /> {received ? T.checkReceived : T.checkSend}</label>
                  <div className="space-y-1"><Label>{received ? T.otherReceived : T.otherOptional}</Label><Textarea rows={2} maxLength={500} value={doc.other} onChange={(e) => setDoc({ ...doc, other: e.target.value })} /></div>
                  {!doc.documents && !doc.checks && <p className="text-xs text-muted-foreground">{received ? T.selectReceived : T.selectSent}</p>}
                </div>
              )}
              {to != null && !isDoc && !appointing && <div className="space-y-1"><Label>{T.remarksOptional}</Label><Textarea rows={2} maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>}
            </>
          )}
          {confirming && (
            <div className="space-y-2">
              <p>{fillNodes(T.confirmChange, { market: <b>{plan.marketName}</b>, from: <b>{st(plan.statusLabel)}</b>, to: <b>{st(label)}</b> })}</p>
              {isDoc && <InfoBlock title={received ? T.receivedShort : T.youSending} info={{ documents: doc.documents, checks: doc.checks, other: doc.other.trim() || null }} />}
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
              {e.sentInfo && <InfoBlock title={T.bySo} info={e.sentInfo} />}
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
