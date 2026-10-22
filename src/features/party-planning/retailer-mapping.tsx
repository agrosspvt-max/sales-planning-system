"use client";

import { useState } from "react";
import { Role } from "@prisma/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { RETAILER_NAME_MAX, validateRetailerInput } from "@/lib/retailer";
import { formatDateTimeDMY } from "@/lib/date-format";
import { useAdminPermission } from "@/features/accounts/permission-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLabels } from "./party-labels";
import { RequesterCell } from "./requester-display";
import type { RetailerDealerChoice, RetailerDto, RetailerRequestDto } from "./retailer.server";

function useRetailerLabels() {
  return useLabels({
    title: "party_planning.retailer.title", add: "party_planning.retailer.add", name: "party_planning.retailer.name", firm: "party_planning.retailer.firm", phone: "party_planning.retailer.phone", dealers: "party_planning.retailer.dealers",
    placeholder: "party_planning.retailer.placeholder", search: "party_planning.retailer.search", noDealers: "party_planning.retailer.no_dealers", noMatches: "party_planning.retailer.no_matches", remove: "party_planning.retailer.remove", unavailable: "party_planning.retailer.unavailable",
    submit: "party_planning.retailer.submit", cancel: "party_planning.common.cancel", saving: "party_planning.common.saving", sent: "party_planning.retailer.sent", myRequests: "party_planning.retailer.my_requests", approvedList: "party_planning.retailer.approved_list",
    requested: "party_planning.retailer.view.requested", approved: "party_planning.retailer.view.approved",
    serial: "party_planning.territory.col.serial_no", date: "party_planning.retailer.date", created: "party_planning.retailer.created", by: "party_planning.retailer.by", status: "party_planning.retailer.status", action: "party_planning.territory.col.action",
    pending: "party_planning.retailer.pending", resolved: "party_planning.retailer.resolved", PENDING: "party_planning.retailer.status_pending", APPROVED: "party_planning.retailer.status_approved", REJECTED: "party_planning.retailer.status_rejected",
    approve: "party_planning.retailer.approve", reject: "party_planning.retailer.reject", details: "party_planning.retailer.details", reason: "party_planning.retailer.reason", approveTitle: "party_planning.retailer.approve_title", rejectTitle: "party_planning.retailer.reject_title",
    decided: "party_planning.retailer.decided", noRequests: "party_planning.retailer.no_requests", noRetailers: "party_planning.retailer.no_retailers", failed: "party_planning.retailer.failed", refresh: "party_planning.retailer.refresh", done: "party_planning.retailer.done", forbidden: "party_planning.retailer.forbidden",
    noTerritory: "party_planning.territory.requester.no_territory", phoneHelp: "party_planning.retailer.phone_help",
    name_required: "party_planning.retailer.error.name_required", name_long: "party_planning.retailer.error.name_long", firm_required: "party_planning.retailer.error.firm_required", firm_long: "party_planning.retailer.error.firm_long", phone_invalid: "party_planning.retailer.error.phone_invalid", dealers_required: "party_planning.retailer.error.dealers_required", dealers_too_many: "party_planning.retailer.error.dealers_too_many",
  });
}
const endpoint = "/api/territory-mapping/retailers";
const variant = (status: string) => status === "APPROVED" ? "success" as const : status === "REJECTED" ? "destructive" as const : "secondary" as const;
function Dealers({ dealers }: { dealers: { id: string; name: string }[] }) { return <ul className="max-h-32 max-w-xs space-y-1 overflow-y-auto whitespace-normal">{dealers.map((d) => <li key={d.id}>{d.name}</li>)}</ul>; }
function invalidateRetailers(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["retailers"] });
  void qc.invalidateQueries({ queryKey: ["retailer-requests"] });
}

export function RetailerMappingTab({ role, addOpen, onAddClose }: { role: Role; addOpen: boolean; onAddClose: () => void }) {
  const L = useRetailerLabels();
  const owner = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const [notice, setNotice] = useState(false);
  const [view, setView] = useState<"requested" | "approved">(owner ? "requested" : "approved");
  const retailers = useQuery<RetailerDto[]>({ queryKey: ["retailers"], queryFn: () => api.get(endpoint), enabled: view === "approved" });
  const mine = useQuery<RetailerRequestDto[]>({ queryKey: ["retailer-requests", "mine"], queryFn: () => api.get(`${endpoint}/requests?scope=mine`), enabled: owner && view === "requested" });
  return <div className="space-y-5" data-testid="retailer-mapping">
    {notice && !addOpen && <p role="status" className="text-sm text-success">{L.sent}</p>}
    {owner && <div className="inline-flex rounded-md border p-0.5 text-sm" role="group" aria-label={L.title}>
      {(["requested", "approved"] as const).map((value) => <button type="button" key={value} aria-pressed={view === value} onClick={() => setView(value)} className={`rounded px-3 py-1.5 ${view === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{L[value]}</button>)}
    </div>}
    {owner && view === "requested" ? <section aria-label={L.myRequests}>
      <RetailerRequestsTable rows={(mine.data ?? []).filter((r) => r.status !== "APPROVED")} loading={mine.isLoading} failed={mine.isError} />
    </section> : <section className="space-y-2" aria-label={L.approvedList}>
      <div className="overflow-auto rounded-lg border"><Table><TableHeader><TableRow>{[L.serial, L.name, L.firm, L.phone, L.dealers, L.created].map((label) => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>
        {retailers.isLoading ? <TableRow><TableCell colSpan={6}><Skeleton className="h-8" /></TableCell></TableRow> : retailers.isError ? <TableRow><TableCell colSpan={6} role="alert">{L.failed}</TableCell></TableRow> : !retailers.data?.length ? <TableRow><TableCell colSpan={6}>{L.noRetailers}</TableCell></TableRow> : retailers.data.map((r, i) => <TableRow key={r.id}><TableCell>{i + 1}</TableCell><TableCell>{r.name}</TableCell><TableCell>{r.firmName}</TableCell><TableCell className="whitespace-nowrap">{r.phone}</TableCell><TableCell><Dealers dealers={r.dealers} /></TableCell><TableCell className="whitespace-nowrap">{formatDateTimeDMY(r.createdAt)}</TableCell></TableRow>)}
      </TableBody></Table></div>
    </section>}
    {owner && addOpen && <AddRetailerDialog onClose={onAddClose} onCreated={() => { onAddClose(); setNotice(true); setView("requested"); }} />}
  </div>;
}

export function AddRetailerDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const L = useRetailerLabels();
  const qc = useQueryClient();
  const [retailerName, setName] = useState("");
  const [firmName, setFirm] = useState("");
  const [phone, setPhone] = useState("");
  const [dealerIds, setDealerIds] = useState<string[]>([]);
  const [submissionKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const choices = useQuery<RetailerDealerChoice[]>({ queryKey: ["retailer-dealer-choices"], queryFn: () => api.get(`${endpoint}/choices`), staleTime: 0 });
  const save = useMutation({ mutationFn: () => api.post(`${endpoint}/requests`, { retailerName, firmName, phone, dealerIds, submissionKey }),
    onSuccess: () => { invalidateRetailers(qc); onCreated(); }, onError: (e) => setError((e as Error).message) });
  const submit = () => {
    const problem = validateRetailerInput({ retailerName, firmName, phone, dealerIds });
    if (problem) { setError(L[problem]); return; }
    setError(null); save.mutate();
  };
  return <Dialog open onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}><DialogContent className="max-h-[90vh] overflow-y-auto">
    <DialogHeader><DialogTitle>{L.add}</DialogTitle></DialogHeader>
    <div className="space-y-3">
      <div className="space-y-1"><Label htmlFor="retailer-name">{L.name} *</Label><Input id="retailer-name" required maxLength={RETAILER_NAME_MAX} value={retailerName} disabled={save.isPending} onChange={(e) => setName(e.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="retailer-firm">{L.firm} *</Label><Input id="retailer-firm" required maxLength={RETAILER_NAME_MAX} value={firmName} disabled={save.isPending} onChange={(e) => setFirm(e.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="retailer-phone">{L.phone} *</Label><Input id="retailer-phone" type="tel" inputMode="numeric" pattern="[0-9]{10}" maxLength={10} required value={phone} disabled={save.isPending} onChange={(e) => setPhone(e.target.value)} /><p className="text-xs text-muted-foreground">{L.phoneHelp}</p></div>
      <div className="space-y-1"><Label>{L.dealers} *</Label><SearchableMultiSelect label={L.dealers} options={(choices.data ?? []).map((d) => ({ value: d.id, label: d.name }))} value={dealerIds} onChange={setDealerIds} placeholder={L.placeholder} searchPlaceholder={L.search} emptyText={L.noDealers} noMatchText={L.noMatches} removeLabel={L.remove} unavailableLabel={L.unavailable} disabled={choices.isLoading || choices.isError || save.isPending} /></div>
      {choices.isError && <p role="alert" className="text-sm text-destructive">{L.failed}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    <DialogFooter><Button variant="outline" disabled={save.isPending} onClick={onClose}>{L.cancel}</Button><Button disabled={save.isPending || choices.isLoading || choices.isError || !choices.data?.length} onClick={submit}>{save.isPending ? L.saving : L.submit}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export function RetailerRequestsTab() {
  const L = useRetailerLabels();
  const canManage = useAdminPermission("partyPlanning", "manage");
  const [view, setView] = useState<"pending" | "resolved">("pending");
  const query = useQuery<RetailerRequestDto[]>({ queryKey: ["retailer-requests", "review", view], queryFn: () => api.get(`${endpoint}/requests?view=${view}`), enabled: canManage });
  if (!canManage) return <p role="alert">{L.forbidden}</p>;
  return <div className="space-y-3" data-testid="retailer-review"><div className="flex justify-between gap-2"><div className="inline-flex rounded-md border p-0.5 text-sm">{(["pending", "resolved"] as const).map((value) => <button type="button" key={value} aria-pressed={view === value} onClick={() => setView(value)} className={`rounded px-3 py-1.5 ${view === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{L[value]}{view === value && query.data ? ` (${query.data.length})` : ""}</button>)}</div><Button size="sm" variant="outline" onClick={() => void query.refetch()}>{L.refresh}</Button></div>
    <RetailerRequestsTable rows={query.data ?? []} loading={query.isLoading} failed={query.isError} review={view === "pending"} showRequester />
  </div>;
}

function RetailerRequestsTable({ rows, loading, failed, review = false, showRequester = false }: { rows: RetailerRequestDto[]; loading: boolean; failed: boolean; review?: boolean; showRequester?: boolean }) {
  const L = useRetailerLabels();
  const qc = useQueryClient();
  const canManage = useAdminPermission("partyPlanning", "manage");
  const [selected, setSelected] = useState<{ row: RetailerRequestDto; action: "details" | "approve" | "reject" } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const decide = useMutation({ mutationFn: (value: { id: string; action: "approve" | "reject" }) => api.post(`${endpoint}/requests/${value.id}/decide`, { action: value.action, reason: value.action === "reject" ? reason : undefined }),
    onSuccess: () => { setSelected(null); setReason(""); setError(null); setNotice(true); invalidateRetailers(qc); }, onError: (e) => { setError((e as Error).message); invalidateRetailers(qc); } });
  const open = (row: RetailerRequestDto, action: "details" | "approve" | "reject") => { setSelected({ row, action }); setReason(""); setError(null); setNotice(false); };
  const cols = showRequester ? 9 : 8;
  return <div className="space-y-2">
    {notice && <p role="status" className="text-sm text-success">{L.done}</p>}
    <div className="overflow-auto rounded-lg border"><Table><TableHeader><TableRow>
      {[L.serial, L.name, L.firm, L.phone, L.dealers].map((text) => <TableHead key={text}>{text}</TableHead>)}{showRequester && <TableHead>{L.by}</TableHead>}{[L.date, L.status, L.action].map((text) => <TableHead key={text}>{text}</TableHead>)}
    </TableRow></TableHeader><TableBody>
      {loading ? <TableRow><TableCell colSpan={cols}><Skeleton className="h-8" /></TableCell></TableRow> : failed ? <TableRow><TableCell colSpan={cols} role="alert">{L.failed}</TableCell></TableRow> : !rows.length ? <TableRow><TableCell colSpan={cols}>{L.noRequests}</TableCell></TableRow> : rows.map((r, i) => <TableRow key={r.id} data-request-id={r.id}>
        <TableCell>{i + 1}</TableCell><TableCell>{r.retailerName}</TableCell><TableCell>{r.firmName}</TableCell><TableCell className="whitespace-nowrap">{r.phone}</TableCell><TableCell><Dealers dealers={r.dealers} /></TableCell>
        {showRequester && <RequesterCell territory={r.requestedByTerritory} name={r.requestedByName} fallback={L.noTerritory} />}
        <TableCell className="whitespace-nowrap">{formatDateTimeDMY(r.createdAt)}</TableCell><TableCell><Badge variant={variant(r.status)}>{L[r.status]}</Badge>{r.decidedAt && <div className="mt-1 text-xs text-muted-foreground">{r.decidedByName} · {formatDateTimeDMY(r.decidedAt)}</div>}{r.rejectionReason && <p className="text-xs text-destructive">{r.rejectionReason}</p>}</TableCell>
        <TableCell><div className="flex justify-end gap-1"><Button variant="outline" size="sm" disabled={decide.isPending} onClick={() => open(r, "details")}>{L.details}</Button>{review && canManage && r.status === "PENDING" && <><Button size="sm" disabled={decide.isPending} onClick={() => open(r, "approve")}>{L.approve}</Button><Button size="sm" variant="destructive" disabled={decide.isPending} onClick={() => open(r, "reject")}>{L.reject}</Button></>}</div></TableCell>
      </TableRow>)}
    </TableBody></Table></div>
    {selected && <Dialog open onOpenChange={(next) => { if (!next && !decide.isPending) setSelected(null); }}><DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{selected.action === "approve" ? L.approveTitle : selected.action === "reject" ? L.rejectTitle : L.details}</DialogTitle></DialogHeader>
      <dl className="space-y-2 text-sm">{[[L.name, selected.row.retailerName], [L.firm, selected.row.firmName], [L.phone, selected.row.phone], [L.by, selected.row.requestedByName], [L.date, formatDateTimeDMY(selected.row.createdAt)], [L.status, L[selected.row.status]]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}<div><dt className="text-muted-foreground">{L.dealers}</dt><dd><Dealers dealers={selected.row.dealers} /></dd></div>
        {selected.row.decidedAt && <div><dt className="text-muted-foreground">{L.decided}</dt><dd>{selected.row.decidedByName} · {formatDateTimeDMY(selected.row.decidedAt)}</dd></div>}{selected.row.rejectionReason && <div><dt className="text-muted-foreground">{L.reason}</dt><dd>{selected.row.rejectionReason}</dd></div>}
      </dl>
      {selected.action === "reject" && <div className="space-y-1"><Label htmlFor="retailer-rejection">{L.reason} *</Label><Textarea id="retailer-rejection" value={reason} maxLength={1000} disabled={decide.isPending} onChange={(e) => setReason(e.target.value)} /></div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={decide.isPending} onClick={() => setSelected(null)}>{L.cancel}</Button>{selected.action !== "details" && canManage && <Button variant={selected.action === "reject" ? "destructive" : "default"} disabled={decide.isPending || (selected.action === "reject" && reason.trim().length < 3)} onClick={() => { if (selected.action !== "details") decide.mutate({ id: selected.row.id, action: selected.action }); }}>{decide.isPending ? L.saving : selected.action === "reject" ? L.reject : L.approve}</Button>}</DialogFooter>
    </DialogContent></Dialog>}
  </div>;
}
