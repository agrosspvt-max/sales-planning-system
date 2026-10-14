"use client";

import { useState } from "react";
import { formatDMY } from "@/lib/date-format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Check, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { marketNameKey } from "@/lib/territory-mapping";
import { type ApprovalStatus } from "@/lib/seasonal-plan";
import type { PlanStage } from "@/lib/monthly-plan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import { PartyPlanModeLinks } from "./party-planning-page";
import { fill, useLabels } from "./party-labels";

/* ------------------------------------------- DTOs (mirror seasonal.server.ts) ------------------------------------------- */

/** `id` is null for a territory name with no Market record yet — it is then selected by `territoryMappingId` and the server resolves the record on save. */
interface Market { id: string | null; territoryMappingId: string | null; name: string }
interface EligibleMarkets { markets: Market[] }
const optionKey = (m: Market) => m.id ?? `territory:${m.territoryMappingId}`;
/** The save payload for a chosen option: the Market id, or the owner's territory mapping + the name shown (the server re-verifies both). */
const choiceBody = (m: Market) => (m.id ? { marketId: m.id } : { territoryMappingId: m.territoryMappingId, expectedMarket: m.name });
interface Plan {
  id: string; sheetId: string; seasonName: string; ownerName: string; marketId: string; marketName: string;
  type: "Existing" | "New" | null; marketPotential: string | null; status: "—" | "Pending" | "Appointed"; appointmentDate: string | null;
  approvalStatus: ApprovalStatus; rejectionStage: string | null; rejectionReason: string | null;
  rmDecidedByName: string | null; rmDecidedAt: string | null; adminDecidedByName: string | null; adminDecidedAt: string | null; createdAt: string; editable: boolean; canReview: boolean;
}

const APPROVAL_VARIANT: Record<ApprovalStatus, "muted" | "secondary" | "success" | "destructive"> = { DRAFT: "muted", PENDING_RM: "secondary", PENDING_ADMIN: "secondary", APPROVED: "success", REJECTED: "destructive" };
const dash = <span className="text-muted-foreground">—</span>;
const dateText = (iso: string | null) => (iso ? formatDMY(iso) : null);

/** Market picker: type to search the Phase-1 Market list; the chosen Market is resolved to its id (only an existing Market is accepted). */
function MarketInput({ markets, value, onChange, listId, className }: { markets: Market[]; value: string; onChange: (text: string, market: Market | null) => void; listId: string; className?: string }) {
  const placeholder = useLabel("party_planning.seasonal.placeholder.search_market");
  const resolve = (text: string) => markets.find((m) => marketNameKey(m.name) === marketNameKey(text)) ?? null;
  return (
    <>
      <Input className={className} list={listId} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value, resolve(e.target.value))} />
      <datalist id={listId}>{markets.map((m) => <option key={optionKey(m)} value={m.name} />)}</datalist>
    </>
  );
}

/**
 * The Markets THIS planner may choose for this Seasonal Plan: their Existing Markets + their approved Vacant Markets (server-resolved from the signed-in
 * user and the plan — never the global Market list, never a browser-supplied officer). Its own cache key per plan, and fetched afresh every time a
 * dialog opens, so a new dealer mapping or a final approval shows up without reloading the page.
 */
function useEligibleMarkets(sheetId: string) {
  return useQuery<EligibleMarkets>({
    queryKey: ["seasonal-eligible-markets", sheetId], queryFn: () => api.get<EligibleMarkets>(`/api/seasonal-sheets/${sheetId}/markets`),
    staleTime: 0, gcTime: 0, refetchOnMount: "always",
  });
}

/** Loading / error / empty states for the Market field; the choices render only when there is something to choose from. */
function MarketChoices({ q, children }: { q: ReturnType<typeof useEligibleMarkets>; children: (markets: Market[]) => React.ReactNode }) {
  const T = useLabels({ loading: "party_planning.seasonal.markets.loading", error: "party_planning.seasonal.markets.error", empty: "party_planning.seasonal.markets.empty" });
  if (q.isLoading) return <p role="status" className="text-sm text-muted-foreground">{T.loading}</p>;
  if (q.error || !q.data) return <p role="alert" className="text-sm text-destructive">{fill(T.error, { message: (q.error as Error | null)?.message ?? "" })}</p>;
  return (
    <>
      {q.data.markets.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{T.empty}</p> : children(q.data.markets)}
    </>
  );
}

interface SheetDetail {
  sheet: { id: string; seasonName: string; seasonOpen: boolean; ownerName: string; status: string; own: boolean };
  season: { id: string; name: string; year: number; period: string | null; months: { name: string }[] };
  plans: Plan[];
}

/**
 * ONE Seasonal Plan (a season's market rows), opened by its id from the list. The season and rows are loaded from that plan — never from the
 * "current season". Add Market / edit / delete / submit work as before for the owner; an RM / Admin sees the rows and approves or rejects the
 * ones waiting on them (the review actions that used to live behind the "To review" tab).
 */
export function SeasonalPlanDetailPage({ role, sheetId, stage = "create" }: { role: Role; sheetId: string; stage?: PlanStage }) {
  const qc = useQueryClient();
  const canPlan = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [rejecting, setRejecting] = useState<Plan | null>(null);
  const [adding, setAdding] = useState(false);
  const L = {
    title: useLabel("party_planning.title"), nav: useLabel("party_planning.nav.seasonal"),
    market: useLabel("party_planning.seasonal.col.market"), type: useLabel("party_planning.seasonal.col.type"), potential: useLabel("party_planning.seasonal.col.market_potential"),
    status: useLabel("party_planning.seasonal.col.status"), date: useLabel("party_planning.seasonal.col.date"),
    approval: useLabel("party_planning.seasonal.col.approval"), action: useLabel("party_planning.seasonal.col.action"),
    empty: useLabel("party_planning.seasonal.empty"),
  };
  const T = useLabels({ planning: "party_planning.crumb.planning", createView: "party_planning.crumb.create_view", crumbPlan: "party_planning.seasonal.crumb_plan", subtitle: "party_planning.seasonal.subtitle_detail", subtitleOfficer: "party_planning.seasonal.subtitle_officer",
    seasonClosed: "party_planning.common.season_closed", existing: "party_planning.seasonal.type.existing", newType: "party_planning.seasonal.type.new", pending: "party_planning.status.pending", appointed: "party_planning.status.appointed",
    DRAFT: "party_planning.status.draft", PENDING_RM: "party_planning.status.awaiting_rm", PENDING_ADMIN: "party_planning.status.awaiting_admin", APPROVED: "party_planning.status.approved", REJECTED: "party_planning.status.rejected",
    rejectedBy: "party_planning.common.rejected_by", decidedRm: "party_planning.common.decided_rm", decidedAdmin: "party_planning.common.decided_admin", submit: "party_planning.action.submit", approve: "party_planning.action.approve", reject: "party_planning.action.reject",
    edit: "party_planning.common.edit", del: "party_planning.common.delete", addMarket: "party_planning.action.add_market", submitAll: "party_planning.seasonal.action.submit_all",
    emptySubmitted: "party_planning.seasonal.empty_entries_submitted", emptyApproved: "party_planning.seasonal.empty_entries_approved", emptyOlder: "party_planning.seasonal.empty_entries_older" });

  const { data: detail, isLoading, error: loadError } = useQuery<SheetDetail>({ queryKey: ["seasonal-sheet", sheetId, stage], queryFn: () => api.get<SheetDetail>(`/api/seasonal-sheets/${sheetId}?stage=${stage}`) });
  const allPlans = detail?.plans;
  const plans = allPlans;
  const refresh = () => { qc.invalidateQueries({ queryKey: ["seasonal-sheet", sheetId] }); qc.invalidateQueries({ queryKey: ["seasonal-sheets"] }); };
  const fail = (e: unknown) => setError((e as Error).message);

  const submitAll = useMutation({ mutationFn: () => api.post(`/api/seasonal-sheets/${sheetId}/submit`, {}), onSuccess: () => { setError(null); refresh(); }, onError: fail });
  const submit = useMutation({ mutationFn: (id: string) => api.post(`/api/seasonal-plans/${id}/submit`, {}), onSuccess: () => { setError(null); refresh(); }, onError: fail });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/seasonal-plans/${id}`), onSuccess: () => { setError(null); refresh(); }, onError: fail });
  const act = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject"; reason?: string }) => api.post(`/api/seasonal-plans/${v.id}/act`, { action: v.action, reason: v.reason }),
    onSuccess: () => { setError(null); setRejecting(null); refresh(); }, onError: fail,
  });

  const sheet = detail?.sheet;
  // The ONLY persistent control for adding a market row (it opens the dialog below; it is not the Territory Mapping "Add Market" request).
  const addMarketButton = stage === "create" && canPlan && sheet?.own && sheet.seasonOpen ? <Button variant="outline" size="sm" className="mt-2" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {T.addMarket}</Button> : null;
  const busy = submit.isPending || remove.isPending || act.isPending;

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: T.planning }, { label: T.createView, href: "/planning/create" }, { label: L.title }, { label: L.nav, href: "/planning/party/seasonal" }, { label: detail ? detail.season.name + " " + detail.season.year : T.crumbPlan }]}
        title={L.title}
        subtitle={`${T.subtitle}${sheet && !sheet.own ? fill(T.subtitleOfficer, { name: sheet.ownerName }) : ""}${sheet && !sheet.seasonOpen ? ` ${T.seasonClosed}` : ""}`}
      />
      <PartyPlanModeLinks mode="seasonal" stage={stage} />

      {loadError && <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{(loadError as Error).message}</div>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{L.market}</TableHead>
            <TableHead>{L.type}</TableHead>
            <TableHead>{L.potential}</TableHead><TableHead>{L.status}</TableHead><TableHead>{L.date}</TableHead>
            <TableHead>{L.approval}</TableHead><TableHead className="text-right">{L.action}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : (plans?.length ?? 0) === 0 ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">{stage === "create" ? L.empty : stage === "older" ? T.emptyOlder : stage === "submitted" ? T.emptySubmitted : T.emptyApproved}</TableCell></TableRow>
                : plans!.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.marketName}</TableCell>
                    <TableCell>{p.type ? (p.type === "New" ? T.newType : T.existing) : dash}</TableCell>
                    <TableCell>{p.marketPotential ?? dash}</TableCell>
                    <TableCell>{p.status === "—" ? dash : <Badge variant={p.status === "Appointed" ? "success" : "secondary"}>{p.status === "Appointed" ? T.appointed : T.pending}</Badge>}</TableCell>
                    <TableCell className="whitespace-nowrap">{dateText(p.appointmentDate) ?? dash}</TableCell>
                    <TableCell>
                      <Badge variant={APPROVAL_VARIANT[p.approvalStatus]}>{T[p.approvalStatus]}</Badge>
                      {p.rejectionReason && <div className="mt-1 max-w-xs text-xs text-destructive">{fill(T.rejectedBy, { stage: p.rejectionStage, reason: p.rejectionReason })}</div>}
                      {(p.rmDecidedByName || p.adminDecidedByName) && <div className="mt-1 text-xs text-muted-foreground">{p.rmDecidedByName && fill(T.decidedRm, { name: p.rmDecidedByName, date: dateText(p.rmDecidedAt) })}{p.rmDecidedByName && p.adminDecidedByName && " · "}{p.adminDecidedByName && fill(T.decidedAdmin, { name: p.adminDecidedByName, date: dateText(p.adminDecidedAt) })}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {p.editable && <>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => submit.mutate(p.id)}><Send className="h-4 w-4" /> {T.submit}</Button>
                          <Button size="sm" variant="ghost" disabled={busy} aria-label={T.edit} onClick={() => setEditing(p)}><Pencil className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} aria-label={T.del} onClick={() => remove.mutate(p.id)}><Trash2 className="h-4 w-4" /></Button>
                        </>}
                        {p.canReview && <>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => act.mutate({ id: p.id, action: "approve" })}><Check className="h-4 w-4" /> {T.approve}</Button>
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setRejecting(p)}><X className="h-4 w-4" /> {T.reject}</Button>
                        </>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
        {!isLoading && addMarketButton && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t p-2">
            <div>{addMarketButton}</div>
            {(allPlans ?? []).some((p) => p.editable) && <Button size="sm" disabled={submitAll.isPending} onClick={() => submitAll.mutate()}><Send className="h-4 w-4" /> {T.submitAll}</Button>}
          </div>
        )}
      </div>

      {adding && <AddPlanDialog sheetId={sheetId} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); refresh(); }} />}
      {editing && <EditDialog plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {rejecting && <RejectDialog plan={rejecting} pending={act.isPending} error={error} onCancel={() => setRejecting(null)} onConfirm={(reason) => act.mutate({ id: rejecting.id, action: "reject", reason })} />}
    </div>
  );
}

/** Add a Market to THIS Seasonal Plan: the searchable Market selector; POST /api/seasonal-plans { sheetId, marketId }. */
function AddPlanDialog({ sheetId, onClose, onAdded }: { sheetId: string; onClose: () => void; onAdded: () => void }) {
  const eligible = useEligibleMarkets(sheetId);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<Market | null>(null);
  const [error, setError] = useState<string | null>(null);
  const T = useLabels({ title: "party_planning.action.add_market", market: "party_planning.seasonal.col.market", select: "party_planning.seasonal.validation.select_market", cancel: "party_planning.common.cancel", addPlan: "party_planning.seasonal.action.add_plan" });
  const create = useMutation({ mutationFn: () => api.post("/api/seasonal-plans", { sheetId, ...choiceBody(choice!) }), onSuccess: onAdded, onError: (e) => setError((e as Error).message) });
  const submit = () => {
    if (!choice) { setError(T.select); return; }
    setError(null); create.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>{T.market} *</Label><MarketChoices q={eligible}>{(markets) => <MarketInput listId="seasonal-add-markets" markets={markets} value={text} onChange={(t, m) => { setText(t); setChoice(m); setError(null); }} />}</MarketChoices></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{T.cancel}</Button>
          <Button disabled={create.isPending || !eligible.data || eligible.data.markets.length === 0} onClick={submit}>{T.addPlan}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ plan, onClose, onSaved }: { plan: Plan; onClose: () => void; onSaved: () => void }) {
  const eligible = useEligibleMarkets(plan.sheetId);
  const [text, setText] = useState(plan.marketName);
  const [choice, setChoice] = useState<Market | null>({ id: plan.marketId, territoryMappingId: null, name: plan.marketName });
  const [error, setError] = useState<string | null>(null);
  const T = useLabels({ title: "party_planning.seasonal.dialog.edit_title", market: "party_planning.seasonal.col.market", cancel: "party_planning.common.cancel", save: "party_planning.common.save" });
  const save = useMutation({ mutationFn: () => api.put(`/api/seasonal-plans/${plan.id}`, choiceBody(choice!)), onSuccess: onSaved, onError: (e) => setError((e as Error).message) });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>{T.market} *</Label><MarketChoices q={eligible}>{(markets) => <MarketInput listId="seasonal-edit-markets" markets={markets} value={text} onChange={(t, m) => { setText(t); setChoice(m); }} />}</MarketChoices></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{T.cancel}</Button>
          <Button disabled={!choice || save.isPending || !eligible.data} onClick={() => save.mutate()}>{T.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ plan, pending, error, onCancel, onConfirm }: { plan: Plan; pending: boolean; error: string | null; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const T = useLabels({ title: "party_planning.common.reject_title", reason: "party_planning.common.reason", cancel: "party_planning.common.cancel", reject: "party_planning.action.reject" });
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{fill(T.title, { name: plan.marketName })}</DialogTitle></DialogHeader>
        <div className="space-y-1.5"><Label>{T.reason} *</Label><Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{T.cancel}</Button>
          <Button variant="destructive" disabled={!reason.trim() || pending} onClick={() => onConfirm(reason.trim())}>{T.reject}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
