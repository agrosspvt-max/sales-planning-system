"use client";

import { useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Check, Upload, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { dealerStatusLabel } from "@/lib/dealer-status";
import { DISTRICT_MAX, POTENTIALS, validateMarketRequest, type ImportPlanRow, type ImportSummary, type Potential } from "@/lib/territory-mapping";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { PartyPlanModeLinks } from "./party-planning-page";

/* ------------------------------------------- DTOs (mirror territory.server.ts) ------------------------------------------- */

interface MarketDto { id: string; name: string; potential: Potential | null; source: string }
interface DealerRow { dealerId: string; partyName: string; status: string; marketId: string | null; marketName: string | null; district: string | null; potential: Potential | null }
interface DealerPage { items: DealerRow[]; total: number; page: number; pageSize: number; totalPages: number; mapped: number; unmapped: number }
interface MarketRequest {
  id: string; marketName: string; potential: Potential; numberOfParties: number; status: "PENDING_RM" | "PENDING_ADMIN" | "APPROVED" | "REJECTED";
  requesterName: string; createdAt: string; rmDecidedByName: string | null; rmDecidedAt: string | null; adminDecidedByName: string | null; adminDecidedAt: string | null;
  rejectionStage: string | null; rejectionReason: string | null;
}
interface ImportPreview { sheetNames: string[]; sheet: string | null; needsSheet: boolean; error: string | null; plan: ImportPlanRow[]; summary: ImportSummary | null }
interface ImportResult { applied: number; noChange: number; skippedUnmatched: number; skippedAmbiguous: number; rejectedInvalid: number; duplicates: number; marketsCreated: number }

const STATUS_VARIANT: Record<string, "success" | "muted" | "secondary" | "destructive"> = { ACTIVE: "success", INACTIVE: "muted", PENDING: "secondary", DEFAULTER: "destructive" };
const REQUEST_TEXT: Record<MarketRequest["status"], string> = { PENDING_RM: "Awaiting RM review", PENDING_ADMIN: "Awaiting Admin review", APPROVED: "Approved", REJECTED: "Rejected" };
const REQUEST_VARIANT: Record<MarketRequest["status"], "secondary" | "success" | "destructive"> = { PENDING_RM: "secondary", PENDING_ADMIN: "secondary", APPROVED: "success", REJECTED: "destructive" };
const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—");
const dash = <span className="text-muted-foreground">—</span>;

/* ===================================================== Page ===================================================== */

export function TerritoryMappingPage({ role }: { role: Role }) {
  const [tab, setTab] = useState<"existing" | "add">("existing");
  const title = useLabel("party_planning.title");
  const territory = useLabel("party_planning.nav.territory");
  const tabExisting = useLabel("party_planning.territory.tab_existing");
  const tabAdd = useLabel("party_planning.territory.tab_add_market");
  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: title }, { label: territory }]}
        title={title}
        subtitle="Map every existing dealer to its Market, and request new Markets for approval."
      />
      <PartyPlanModeLinks mode="territory">
        <UnderlineTabs active={tab} onChange={(key) => setTab(key as "existing" | "add")} tabs={[{ key: "existing", label: tabExisting }, { key: "add", label: tabAdd }]} />
      </PartyPlanModeLinks>
      {tab === "existing" ? <ExistingDealers /> : <AddMarket role={role} />}
    </div>
  );
}

/* ============================================= Existing Dealers ============================================= */

function ExistingDealers() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [market, setMarket] = useState("");
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const L = {
    district: useLabel("party_planning.territory.col.district"), market: useLabel("party_planning.territory.col.market"), potential: useLabel("party_planning.territory.col.potential"),
    party: useLabel("party_planning.territory.col.party_name"), status: useLabel("party_planning.territory.col.status"),
    importExcel: useLabel("party_planning.territory.action.import"), search: useLabel("party_planning.territory.search"),
    allMarkets: useLabel("party_planning.territory.all_markets"), unmapped: useLabel("party_planning.territory.unmapped"), empty: useLabel("party_planning.territory.empty"),
  };
  const { data: markets } = useQuery<MarketDto[]>({ queryKey: ["territory-markets"], queryFn: () => api.get<MarketDto[]>("/api/territory-mapping/markets") });
  const { data, isLoading } = useQuery<DealerPage>({
    queryKey: ["territory-dealers", search, market, page],
    queryFn: () => api.get<DealerPage>(`/api/territory-mapping/dealers?${new URLSearchParams({ search, market, page: String(page), pageSize: "25" })}`),
    placeholderData: keepPreviousData,
  });
  const save = useMutation({
    mutationFn: (v: { dealerId: string; marketId?: string | null; potential?: Potential | null; district?: string | null }) => api.put(`/api/territory-mapping/dealers/${v.dealerId}`, { marketId: v.marketId, potential: v.potential, district: v.district }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ["territory-dealers"] }); },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5"><Label>{L.search}</Label><Input className="w-64" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={L.search} /></div>
          <div className="space-y-1.5"><Label>{L.market}</Label>
            <NativeSelect className="w-52" value={market} onChange={(e) => { setMarket(e.target.value); setPage(1); }}
              options={[{ value: "", label: L.allMarkets }, { value: "__none__", label: L.unmapped }, ...(markets ?? []).map((m) => ({ value: m.id, label: m.name }))]} />
          </div>
          {data && <span className="pb-2 text-sm text-muted-foreground">{data.mapped} mapped · {data.unmapped} unmapped</span>}
        </div>
        <Button variant="outline" onClick={() => setImportOpen(true)}><Upload className="h-4 w-4" /> {L.importExcel}</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow>
            <TableHead className="w-48">{L.district}</TableHead><TableHead className="w-56">{L.market}</TableHead><TableHead className="w-28">{L.potential}</TableHead><TableHead>{L.party}</TableHead><TableHead className="w-32">{L.status}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : (data?.items.length ?? 0) === 0 ? <TableRow><TableCell colSpan={4} className="py-10 text-center text-muted-foreground">{L.empty}</TableCell></TableRow>
                : data!.items.map((row) => (
                  <TableRow key={row.dealerId}>
                    <TableCell className="p-1">
                      <Input key={`${row.dealerId}:${row.district ?? ""}`} className="h-8 w-full" aria-label={L.district} defaultValue={row.district ?? ""} placeholder="—" maxLength={DISTRICT_MAX} disabled={save.isPending}
                        onBlur={(e) => { const v = e.target.value.trim(); if (v !== (row.district ?? "")) save.mutate({ dealerId: row.dealerId, district: v || null }); }} />
                    </TableCell>
                    <TableCell className="p-1">
                      <NativeSelect className="h-8 w-full" aria-label={L.market} value={row.marketId ?? ""} disabled={save.isPending} placeholder="—"
                        options={(markets ?? []).map((m) => ({ value: m.id, label: m.name }))}
                        onChange={(e) => save.mutate({ dealerId: row.dealerId, marketId: e.target.value || null })} />
                    </TableCell>
                    <TableCell className="p-1">
                      <NativeSelect className="h-8 w-full" aria-label={L.potential} value={row.potential ?? ""} disabled={save.isPending} placeholder="—"
                        options={POTENTIALS.map((p) => ({ value: p, label: p }))}
                        onChange={(e) => save.mutate({ dealerId: row.dealerId, potential: (e.target.value || null) as Potential | null })} />
                    </TableCell>
                    <TableCell className="font-medium">{row.partyName}</TableCell>
                    <TableCell><Badge variant={STATUS_VARIANT[row.status] ?? "muted"}>{dealerStatusLabel(row.status)}</Badge></TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Page {data.page} of {data.totalPages} · {data.total} total</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onApplied={() => { qc.invalidateQueries({ queryKey: ["territory-dealers"] }); qc.invalidateQueries({ queryKey: ["territory-markets"] }); }} />}
    </div>
  );
}

/* ============================================= Import (preview → confirm) ============================================= */

async function postImport<T>(url: string, file: File, sheet: string | null, resolutions?: Record<number, string>): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  if (sheet) form.append("sheet", sheet);
  if (resolutions) form.append("resolutions", JSON.stringify(resolutions));
  const res = await fetch(url, { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Import failed");
  return body as T;
}

const RESULT_TEXT: Record<ImportPlanRow["status"], string> = { MATCHED: "Matched", UNMATCHED: "Unmatched", AMBIGUOUS: "Ambiguous", INVALID: "Invalid", DUPLICATE: "Duplicate", CONFLICT: "Conflict" };

function ImportDialog({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewMut = useMutation({
    mutationFn: (v: { file: File; sheet: string | null }) => postImport<ImportPreview>("/api/territory-mapping/import/preview", v.file, v.sheet),
    onSuccess: (p) => { setError(null); setPreview(p); setSheet(p.sheet); setPicks({}); },
    onError: (e) => setError((e as Error).message),
  });
  const commitMut = useMutation({
    mutationFn: () => postImport<ImportResult>("/api/territory-mapping/import/commit", file!, sheet, picks),
    onSuccess: (r) => { setError(null); setResult(r); onApplied(); },
    onError: (e) => setError((e as Error).message),
  });

  // Rows the user has resolved count as matched in the summary shown next to Confirm; the server re-validates every pick.
  const plan = preview?.plan ?? [];
  const unresolved = plan.filter((r) => r.status === "AMBIGUOUS" && !picks[r.rowNumber]).length;
  const willApply = plan.filter((r) => (r.status === "MATCHED" && r.action !== "NO_CHANGE") || (r.status === "AMBIGUOUS" && picks[r.rowNumber])).length;

  const group = (status: ImportPlanRow["status"]) => plan.filter((r) => r.status === status);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader><DialogTitle>Import Markets from Excel</DialogTitle></DialogHeader>
        {result ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">Import applied.</p>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>Applied: {result.applied}{result.marketsCreated ? ` (${result.marketsCreated} new Market${result.marketsCreated === 1 ? "" : "s"} created)` : ""}</li>
              <li>Already mapped (no change): {result.noChange}</li>
              <li>Skipped — unmatched: {result.skippedUnmatched}</li>
              <li>Skipped — ambiguous: {result.skippedAmbiguous}</li>
              <li>Rejected — invalid / conflicting / outside scope: {result.rejectedInvalid}</li>
              <li>Duplicate rows: {result.duplicates}</li>
            </ul>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Excel file — columns <b>Dealer</b>, <b>Market</b> and <b>District</b></Label>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="block text-sm"
                onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setPreview(null); setSheet(null); setError(null); if (f) previewMut.mutate({ file: f, sheet: null }); }} />
              <p className="text-xs text-muted-foreground">Parsed in memory. Nothing changes until you confirm. Dealers are never created from this file.</p>
            </div>
            {preview && preview.sheetNames.length > 1 && (
              <div className="space-y-1.5"><Label>Sheet</Label>
                <NativeSelect className="w-64" value={sheet ?? ""} placeholder="Select a sheet…" options={preview.sheetNames.map((n) => ({ value: n, label: n }))}
                  onChange={(e) => { setSheet(e.target.value || null); if (file && e.target.value) previewMut.mutate({ file, sheet: e.target.value }); }} />
              </div>
            )}
            {previewMut.isPending && <Skeleton className="h-16 w-full" />}
            {preview?.error && <p className="text-sm text-destructive">{preview.error}</p>}
            {preview?.summary && (
              <div className="space-y-4">
                <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-4">
                  <span>Matched: <b>{preview.summary.matched}</b></span><span>Unmatched: <b>{preview.summary.unmatched}</b></span>
                  <span>Ambiguous: <b>{preview.summary.ambiguous}</b> ({unresolved} to resolve)</span><span>Invalid: <b>{preview.summary.invalid + preview.summary.conflicts}</b></span>
                  <span>Duplicates: <b>{preview.summary.duplicates}</b></span><span>Already mapped: <b>{preview.summary.noChange}</b></span>
                  <span>New Markets: <b>{preview.summary.newMarkets}</b></span><span>District updates: <b>{preview.summary.districtUpdates}</b></span><span>Will apply: <b>{willApply}</b></span>
                </div>
                <PlanTable title="Matched" rows={group("MATCHED")} render={(r) => (
                  <><TableCell>{r.excelDealer}</TableCell><TableCell>{r.partyName}</TableCell>
                    <TableCell>{r.currentDistrict || "—"}</TableCell>
                    <TableCell>{r.districtName || <span className="text-muted-foreground">not in sheet</span>}</TableCell>
                    <TableCell>{r.currentMarket || "—"}</TableCell>
                    <TableCell>{r.marketName}{r.newMarket && <Badge variant="secondary" className="ml-2">new</Badge>}</TableCell>
                    <TableCell>{changeText(r)}</TableCell></>
                )} head={["Excel Dealer", "Matched Party", "Current District", "Excel District", "Current Market", "Excel Market", "Result"]} />
                <PlanTable title="Ambiguous — choose the right dealer" rows={group("AMBIGUOUS")} head={["Excel Dealer", "District · Market", "Possible Matches", "Result"]} render={(r) => (
                  <><TableCell>{r.excelDealer}</TableCell><TableCell>{districtMarket(r)}</TableCell>
                    <TableCell><NativeSelect className="h-8" value={picks[r.rowNumber] ?? ""} placeholder="Choose…"
                      options={(r.candidates ?? []).map((c) => ({ value: c.dealerId, label: c.partyName }))}
                      onChange={(e) => setPicks((p) => { const next = { ...p }; if (e.target.value) next[r.rowNumber] = e.target.value; else delete next[r.rowNumber]; return next; })} /></TableCell>
                    <TableCell>{picks[r.rowNumber] ? "Resolved" : "Needs a choice — skipped if left blank"}</TableCell></>
                )} />
                <PlanTable title="Unmatched" rows={group("UNMATCHED")} head={["Excel Dealer", "District · Market", "Result"]} render={(r) => (<><TableCell>{r.excelDealer}</TableCell><TableCell>{districtMarket(r)}</TableCell><TableCell>{r.reason}</TableCell></>)} />
                <PlanTable title="Invalid / conflicting / duplicate" rows={plan.filter((r) => ["INVALID", "CONFLICT", "DUPLICATE"].includes(r.status))} head={["Excel Row", "Dealer · District · Market", "Reason"]}
                  render={(r) => (<><TableCell>{r.rowNumber} <Badge variant="muted" className="ml-1">{RESULT_TEXT[r.status]}</Badge></TableCell><TableCell>{r.excelDealer || "—"} · {r.excelDistrict || "—"} · {r.excelMarket || "—"}</TableCell><TableCell>{r.reason}</TableCell></>)} />
              </div>
            )}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{result ? "Close" : "Cancel"}</Button>
          {!result && <Button disabled={!preview?.summary || willApply === 0 || commitMut.isPending} onClick={() => commitMut.mutate()}><Check className="h-4 w-4" /> {commitMut.isPending ? "Applying…" : `Confirm import (${willApply})`}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const districtMarket = (r: ImportPlanRow) => `${r.excelDistrict || "—"} · ${r.excelMarket || "—"}`;
/** What will change for a matched row, spelled out: Market and/or District added or updated, or already matching. */
function changeText(r: ImportPlanRow): string {
  const parts: string[] = [];
  if (r.marketChanged) parts.push(r.currentMarket ? `Market updated (was ${r.currentMarket})` : "Market added");
  if (r.districtAction === "ADD") parts.push("District added");
  if (r.districtAction === "CHANGE") parts.push(`District updated (was ${r.currentDistrict})`);
  return parts.length ? parts.join("; ") : "Already matching";
}

function PlanTable({ title, rows, head, render }: { title: string; rows: ImportPlanRow[]; head: string[]; render: (row: ImportPlanRow) => React.ReactNode }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1.5 text-sm font-semibold">{title} ({rows.length})</h3>
      <div className="max-h-64 overflow-auto rounded-md border">
        <Table>
          <TableHeader><TableRow>{head.map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{rows.map((r) => <TableRow key={r.rowNumber}>{render(r)}</TableRow>)}</TableBody>
        </Table>
      </div>
    </div>
  );
}

/* ================================================= Add Market ================================================= */

function AddMarket({ role }: { role: Role }) {
  const qc = useQueryClient();
  const canRequest = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const canReview = role === Role.REGIONAL_MANAGER || isAdministrativeRole(role);
  const [name, setName] = useState("");
  const [potential, setPotential] = useState("");
  const [parties, setParties] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<"mine" | "review" | "history">(canReview ? "review" : "mine");
  const [rejecting, setRejecting] = useState<MarketRequest | null>(null);
  const L = {
    name: useLabel("party_planning.territory.field.market_name"), potential: useLabel("party_planning.territory.field.market_potential"),
    parties: useLabel("party_planning.territory.field.number_of_parties"), send: useLabel("party_planning.territory.action.send_request"),
  };
  const send = useMutation({
    mutationFn: () => api.post<MarketRequest>("/api/territory-mapping/market-requests", { marketName: name, potential, numberOfParties: parties }),
    onSuccess: () => { setError(null); setNotice("Request sent."); setName(""); setPotential(""); setParties(""); qc.invalidateQueries({ queryKey: ["market-requests"] }); },
    onError: (e) => { setNotice(null); setError((e as Error).message); },
  });
  const submit = () => {
    setNotice(null);
    const problem = validateMarketRequest({ marketName: name, potential, numberOfParties: parties });
    if (problem) { setError(problem); return; }
    setError(null); send.mutate();
  };

  const { data: requests, isLoading } = useQuery<MarketRequest[]>({ queryKey: ["market-requests", view], queryFn: () => api.get<MarketRequest[]>(`/api/territory-mapping/market-requests?view=${view}`) });
  const act = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject"; reason?: string }) => api.post(`/api/territory-mapping/market-requests/${v.id}/act`, { action: v.action, reason: v.reason }),
    onSuccess: () => { setRejecting(null); qc.invalidateQueries({ queryKey: ["market-requests"] }); qc.invalidateQueries({ queryKey: ["territory-markets"] }); },
    onError: (e) => setError((e as Error).message),
  });

  const views: { key: typeof view; label: string }[] = [
    ...(canReview ? [{ key: "review" as const, label: "To review" }] : []),
    ...(canRequest ? [{ key: "mine" as const, label: "My requests" }] : []),
    { key: "history" as const, label: "History" },
  ];

  return (
    <div className="space-y-5">
      {canRequest && (
        <div className="max-w-xl space-y-3 rounded-lg border bg-background p-4">
          <div className="space-y-1.5"><Label>{L.name} *</Label><Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>{L.potential} *</Label>
              <NativeSelect value={potential} placeholder="Select…" options={POTENTIALS.map((p) => ({ value: p, label: p }))} onChange={(e) => setPotential(e.target.value)} />
            </div>
            <div className="space-y-1.5"><Label>{L.parties} *</Label>
              <Input type="number" min={1} step={1} inputMode="numeric" value={parties} onChange={(e) => setParties(e.target.value)} />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {notice && <p className="text-sm text-success">{notice}</p>}
          <Button disabled={send.isPending} onClick={submit}>{L.send}</Button>
        </div>
      )}

      <div className="space-y-3">
        <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
          {views.map((v) => (
            <button key={v.key} onClick={() => setView(v.key)} className={`rounded px-3 py-1.5 font-medium ${view === v.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{v.label}</button>
          ))}
        </div>
        {!canRequest && error && <p className="text-sm text-destructive">{error}</p>}
        <div className="overflow-auto rounded-lg border bg-background">
          <Table>
            <TableHeader><TableRow>
              <TableHead>{L.name}</TableHead><TableHead>{L.potential}</TableHead><TableHead>{L.parties}</TableHead><TableHead>Requested by</TableHead><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead>Decision</TableHead>
              {view === "review" && <TableHead className="text-right">Action</TableHead>}
            </TableRow></TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                : (requests?.length ?? 0) === 0 ? <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No requests here.</TableCell></TableRow>
                  : requests!.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.marketName}</TableCell><TableCell>{r.potential}</TableCell><TableCell>{r.numberOfParties}</TableCell>
                      <TableCell>{r.requesterName}</TableCell><TableCell className="whitespace-nowrap">{dateText(r.createdAt)}</TableCell>
                      <TableCell><Badge variant={REQUEST_VARIANT[r.status]}>{REQUEST_TEXT[r.status]}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.rmDecidedByName && <div>RM: {r.rmDecidedByName} · {dateText(r.rmDecidedAt)}</div>}
                        {r.adminDecidedByName && <div>Admin: {r.adminDecidedByName} · {dateText(r.adminDecidedAt)}</div>}
                        {r.rejectionReason && <div className="text-destructive">Rejected by {r.rejectionStage}: {r.rejectionReason}</div>}
                        {!r.rmDecidedByName && !r.adminDecidedByName && dash}
                      </TableCell>
                      {view === "review" && (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: "approve" })}><Check className="h-4 w-4" /> Approve</Button>
                            <Button size="sm" variant="ghost" className="text-destructive" disabled={act.isPending} onClick={() => setRejecting(r)}><X className="h-4 w-4" /> Reject</Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        </div>
      </div>
      {rejecting && <RejectDialog request={rejecting} pending={act.isPending} error={error} onCancel={() => setRejecting(null)} onConfirm={(reason) => act.mutate({ id: rejecting.id, action: "reject", reason })} />}
    </div>
  );
}

function RejectDialog({ request, pending, error, onCancel, onConfirm }: { request: MarketRequest; pending: boolean; error: string | null; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Reject “{request.marketName}”</DialogTitle></DialogHeader>
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
