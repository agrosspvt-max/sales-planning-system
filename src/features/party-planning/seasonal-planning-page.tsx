"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Check, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { marketNameKey } from "@/lib/territory-mapping";
import { validatePartyName, PARTY_NAME_MAX, filterSeasonalRows, MARKET_POTENTIAL_FILTERS, type ApprovalStatus } from "@/lib/seasonal-plan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import { PartyPlanModeLinks } from "./party-planning-page";

/* ------------------------------------------- DTOs (mirror seasonal.server.ts) ------------------------------------------- */

interface Market { id: string; name: string }
interface Plan {
  id: string; seasonName: string; ownerName: string; marketId: string; marketName: string;
  type: "Existing" | "New" | null; marketPotential: string | null; status: "—" | "Pending" | "Appointed"; appointmentDate: string | null; partyName: string;
  approvalStatus: ApprovalStatus; rejectionStage: string | null; rejectionReason: string | null;
  rmDecidedByName: string | null; rmDecidedAt: string | null; adminDecidedByName: string | null; adminDecidedAt: string | null; createdAt: string; editable: boolean; canReview: boolean;
}

const APPROVAL_TEXT: Record<ApprovalStatus, string> = { DRAFT: "Draft", PENDING_RM: "Awaiting RM review", PENDING_ADMIN: "Awaiting Admin review", APPROVED: "Approved", REJECTED: "Rejected" };
const APPROVAL_VARIANT: Record<ApprovalStatus, "muted" | "secondary" | "success" | "destructive"> = { DRAFT: "muted", PENDING_RM: "secondary", PENDING_ADMIN: "secondary", APPROVED: "success", REJECTED: "destructive" };
const dash = <span className="text-muted-foreground">—</span>;
const dateText = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString("en-IN", { dateStyle: "medium" }) : null);

/** Market picker: type to search the Phase-1 Market list; the chosen Market is resolved to its id (only an existing Market is accepted). */
function MarketInput({ markets, value, onChange, listId, className }: { markets: Market[]; value: string; onChange: (text: string, marketId: string | null) => void; listId: string; className?: string }) {
  const resolve = (text: string) => markets.find((m) => marketNameKey(m.name) === marketNameKey(text))?.id ?? null;
  return (
    <>
      <Input className={className} list={listId} value={value} placeholder="Search Market…" onChange={(e) => onChange(e.target.value, resolve(e.target.value))} />
      <datalist id={listId}>{markets.map((m) => <option key={m.id} value={m.name} />)}</datalist>
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
export function SeasonalPlanDetailPage({ role, sheetId }: { role: Role; sheetId: string }) {
  const qc = useQueryClient();
  const canPlan = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const [marketFilter, setMarketFilter] = useState("");
  const [potentialFilter, setPotentialFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [rejecting, setRejecting] = useState<Plan | null>(null);
  const [adding, setAdding] = useState(false);
  const L = {
    title: useLabel("party_planning.title"), nav: useLabel("party_planning.nav.seasonal"),
    market: useLabel("party_planning.seasonal.col.market"), type: useLabel("party_planning.seasonal.col.type"), potential: useLabel("party_planning.seasonal.col.market_potential"),
    status: useLabel("party_planning.seasonal.col.status"), date: useLabel("party_planning.seasonal.col.date"), party: useLabel("party_planning.seasonal.col.party_name"),
    approval: useLabel("party_planning.seasonal.col.approval"), action: useLabel("party_planning.seasonal.col.action"),
    search: useLabel("party_planning.seasonal.search"), empty: useLabel("party_planning.seasonal.empty"), emptyFiltered: useLabel("party_planning.seasonal.empty_filtered"),
  };

  const { data: detail, isLoading, error: loadError } = useQuery<SheetDetail>({ queryKey: ["seasonal-sheet", sheetId], queryFn: () => api.get<SheetDetail>(`/api/seasonal-sheets/${sheetId}`) });
  const { data: markets } = useQuery<Market[]>({ queryKey: ["territory-markets"], queryFn: () => api.get<Market[]>("/api/territory-mapping/markets") });
  const allPlans = detail?.plans;
  const plans = allPlans && filterSeasonalRows(allPlans, { market: marketFilter, potential: potentialFilter });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["seasonal-sheet", sheetId] }); qc.invalidateQueries({ queryKey: ["seasonal-sheets"] }); };
  const fail = (e: unknown) => setError((e as Error).message);

  const submit = useMutation({ mutationFn: (id: string) => api.post(`/api/seasonal-plans/${id}/submit`, {}), onSuccess: () => { setError(null); refresh(); }, onError: fail });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/seasonal-plans/${id}`), onSuccess: () => { setError(null); refresh(); }, onError: fail });
  const act = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject"; reason?: string }) => api.post(`/api/seasonal-plans/${v.id}/act`, { action: v.action, reason: v.reason }),
    onSuccess: () => { setError(null); setRejecting(null); refresh(); }, onError: fail,
  });

  const sheet = detail?.sheet;
  // The ONLY persistent control for adding a market row (it opens the dialog below; it is not the Territory Mapping "Add Market" request).
  const addMarketButton = canPlan && sheet?.own && sheet.seasonOpen ? <Button variant="outline" size="sm" className="mt-2" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add Market</Button> : null;
  const busy = submit.isPending || remove.isPending || act.isPending;

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: L.title }, { label: L.nav, href: "/planning/party/seasonal" }, { label: detail ? detail.season.name + " " + detail.season.year : "Seasonal Plan" }]}
        title={L.title}
        subtitle={`Add the markets in which you will develop a party this season, then submit them for approval.${sheet && !sheet.own ? ` Officer: ${sheet.ownerName}.` : ""}${sheet && !sheet.seasonOpen ? " Season closed — read-only." : ""}`}
      />
      <PartyPlanModeLinks mode="seasonal" />

      {loadError && <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{(loadError as Error).message}</div>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow>
            <TableHead>
              <div>{L.market}</div>
              <Input className="mt-1 h-7 w-40 text-xs font-normal normal-case" value={marketFilter} onChange={(e) => setMarketFilter(e.target.value)} placeholder={L.search} aria-label={L.search} />
            </TableHead>
            <TableHead>{L.type}</TableHead>
            <TableHead>
              <div>{L.potential}</div>
              <NativeSelect className="mt-1 h-7 w-24 text-xs font-normal normal-case" value={potentialFilter} onChange={(e) => setPotentialFilter(e.target.value)} aria-label={L.potential} options={[{ value: "", label: "All" }, ...MARKET_POTENTIAL_FILTERS.map((v) => ({ value: v, label: v }))]} />
            </TableHead><TableHead>{L.status}</TableHead><TableHead>{L.date}</TableHead><TableHead>{L.party}</TableHead>
            <TableHead>{L.approval}</TableHead><TableHead className="text-right">{L.action}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : (plans?.length ?? 0) === 0 ? <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">{(allPlans?.length ?? 0) > 0 ? L.emptyFiltered : L.empty}</TableCell></TableRow>
                : plans!.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.marketName}</TableCell>
                    <TableCell>{p.type ?? dash}</TableCell>
                    <TableCell>{p.marketPotential ?? dash}</TableCell>
                    <TableCell>{p.status === "—" ? dash : <Badge variant={p.status === "Appointed" ? "success" : "secondary"}>{p.status}</Badge>}</TableCell>
                    <TableCell className="whitespace-nowrap">{dateText(p.appointmentDate) ?? dash}</TableCell>
                    <TableCell>{p.partyName}</TableCell>
                    <TableCell>
                      <Badge variant={APPROVAL_VARIANT[p.approvalStatus]}>{APPROVAL_TEXT[p.approvalStatus]}</Badge>
                      {p.rejectionReason && <div className="mt-1 max-w-xs text-xs text-destructive">Rejected by {p.rejectionStage}: {p.rejectionReason}</div>}
                      {(p.rmDecidedByName || p.adminDecidedByName) && <div className="mt-1 text-xs text-muted-foreground">{p.rmDecidedByName && `RM: ${p.rmDecidedByName} · ${dateText(p.rmDecidedAt)}`}{p.rmDecidedByName && p.adminDecidedByName && " · "}{p.adminDecidedByName && `Admin: ${p.adminDecidedByName} · ${dateText(p.adminDecidedAt)}`}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {p.editable && <>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => submit.mutate(p.id)}><Send className="h-4 w-4" /> Submit</Button>
                          <Button size="sm" variant="ghost" disabled={busy} aria-label="Edit" onClick={() => setEditing(p)}><Pencil className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} aria-label="Delete" onClick={() => remove.mutate(p.id)}><Trash2 className="h-4 w-4" /></Button>
                        </>}
                        {p.canReview && <>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => act.mutate({ id: p.id, action: "approve" })}><Check className="h-4 w-4" /> Approve</Button>
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setRejecting(p)}><X className="h-4 w-4" /> Reject</Button>
                        </>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
        {!isLoading && addMarketButton && <div className="border-t p-2">{addMarketButton}</div>}
      </div>

      {adding && <AddPlanDialog sheetId={sheetId} markets={markets ?? []} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); setMarketFilter(""); setPotentialFilter(""); refresh(); }} />}
      {editing && <EditDialog plan={editing} markets={markets ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {rejecting && <RejectDialog plan={rejecting} pending={act.isPending} error={error} onCancel={() => setRejecting(null)} onConfirm={(reason) => act.mutate({ id: rejecting.id, action: "reject", reason })} />}
    </div>
  );
}

/** Add a Market to THIS Seasonal Plan: the searchable Market selector + Party Name; POST /api/seasonal-plans { sheetId, marketId, partyName }. */
function AddPlanDialog({ sheetId, markets, onClose, onAdded }: { sheetId: string; markets: Market[]; onClose: () => void; onAdded: () => void }) {
  const [text, setText] = useState("");
  const [marketId, setMarketId] = useState<string | null>(null);
  const [partyName, setPartyName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => api.post("/api/seasonal-plans", { sheetId, marketId, partyName }), onSuccess: onAdded, onError: (e) => setError((e as Error).message) });
  const submit = () => {
    if (!marketId) { setError("Select a Market from the list."); return; }
    const problem = validatePartyName(partyName);
    if (problem) { setError(problem); return; }
    setError(null); create.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add Market</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>Market *</Label><MarketInput listId="seasonal-add-markets" markets={markets} value={text} onChange={(t, id) => { setText(t); setMarketId(id); setError(null); }} /></div>
          <div className="space-y-1.5"><Label>Party Name *</Label><Input maxLength={PARTY_NAME_MAX} value={partyName} placeholder="Tentative party name" onChange={(e) => { setPartyName(e.target.value); setError(null); }} /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={create.isPending} onClick={submit}>Add Plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ plan, markets, onClose, onSaved }: { plan: Plan; markets: Market[]; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(plan.marketName);
  const [marketId, setMarketId] = useState<string | null>(plan.marketId);
  const [party, setParty] = useState(plan.partyName);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api.put(`/api/seasonal-plans/${plan.id}`, { marketId, partyName: party }), onSuccess: onSaved, onError: (e) => setError((e as Error).message) });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Edit Seasonal Plan</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>Market *</Label><MarketInput listId="seasonal-edit-markets" markets={markets} value={text} onChange={(t, id) => { setText(t); setMarketId(id); }} /></div>
          <div className="space-y-1.5"><Label>Party Name *</Label><Input maxLength={PARTY_NAME_MAX} value={party} onChange={(e) => setParty(e.target.value)} /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!marketId || !party.trim() || save.isPending} onClick={() => save.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ plan, pending, error, onCancel, onConfirm }: { plan: Plan; pending: boolean; error: string | null; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Reject “{plan.marketName} — {plan.partyName}”</DialogTitle></DialogHeader>
        <div className="space-y-1.5"><Label>Reason *</Label><Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" disabled={!reason.trim() || pending} onClick={() => onConfirm(reason.trim())}>Reject</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
