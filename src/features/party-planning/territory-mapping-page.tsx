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
import { fill, fillNodes, useLabels } from "./party-labels";

/* ------------------------------------------- DTOs (mirror territory.server.ts) ------------------------------------------- */

interface MarketDto { id: string; name: string; potential: Potential | null; source: string }
interface DealerRow { dealerId: string; partyName: string; status: string; marketId: string | null; marketName: string | null; marketEdited: boolean; district: string | null; potential: Potential | null }
interface DealerPage { items: DealerRow[]; total: number; page: number; pageSize: number; totalPages: number; mapped: number; unmapped: number }
interface MarketRequest {
  id: string; marketName: string; potential: Potential; numberOfParties: number; status: "PENDING_RM" | "PENDING_ADMIN" | "APPROVED" | "REJECTED";
  requesterName: string; createdAt: string; rmDecidedByName: string | null; rmDecidedAt: string | null; adminDecidedByName: string | null; adminDecidedAt: string | null;
  rejectionStage: string | null; rejectionReason: string | null;
}
interface ImportPreview { sheetNames: string[]; sheet: string | null; needsSheet: boolean; error: string | null; plan: ImportPlanRow[]; summary: ImportSummary | null }
interface ImportResult { applied: number; noChange: number; skippedUnmatched: number; skippedAmbiguous: number; rejectedInvalid: number; duplicates: number; marketsCreated: number }

const STATUS_VARIANT: Record<string, "success" | "muted" | "secondary" | "destructive"> = { ACTIVE: "success", INACTIVE: "muted", PENDING: "secondary", DEFAULTER: "destructive" };
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
  const T = useLabels({ planning: "party_planning.crumb.planning", createView: "party_planning.crumb.create_view", subtitle: "party_planning.territory.subtitle" });
  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: T.planning }, { label: T.createView, href: "/planning/create" }, { label: title }, { label: territory }]}
        title={title}
        subtitle={T.subtitle}
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
  const T = useLabels({ counts: "party_planning.territory.msg.mapped_counts", pageOf: "party_planning.territory.msg.page_of", previous: "party_planning.common.previous", next: "party_planning.common.next" });
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
          {data && <span className="pb-2 text-sm text-muted-foreground">{fill(T.counts, { mapped: data.mapped, unmapped: data.unmapped })}</span>}
        </div>
        <Button variant="outline" onClick={() => setImportOpen(true)}><Upload className="h-4 w-4" /> {L.importExcel}</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow>
            <TableHead className="w-48">{L.district}</TableHead><TableHead className="min-w-[22rem]">{L.market}</TableHead><TableHead className="w-28">{L.potential}</TableHead><TableHead>{L.party}</TableHead><TableHead className="w-32">{L.status}</TableHead>
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
                    <TableCell className="p-1"><MarketCell row={row} label={L.market} onError={setError} /></TableCell>
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
          <span className="text-muted-foreground">{fill(T.pageOf, { page: data.page, pages: data.totalPages, total: data.total })}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{T.previous}</Button>
            <Button variant="outline" size="sm" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>{T.next}</Button>
          </div>
        </div>
      )}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onApplied={() => { qc.invalidateQueries({ queryKey: ["territory-dealers"] }); qc.invalidateQueries({ queryKey: ["territory-markets"] }); }} />}
    </div>
  );
}

/* ============================================= Import (preview → confirm) ============================================= */

async function postImport<T>(url: string, file: File, sheet: string | null, importFailed: string, resolutions?: Record<number, string>): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  if (sheet) form.append("sheet", sheet);
  if (resolutions) form.append("resolutions", JSON.stringify(resolutions));
  const res = await fetch(url, { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? importFailed);
  return body as T;
}

function ImportDialog({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const T = useLabels({ title: "party_planning.territory.import.title", applied: "party_planning.territory.import.applied", fileLabel: "party_planning.territory.import.file_label", note: "party_planning.territory.import.note", sheet: "party_planning.territory.import.sheet",
    selectSheet: "party_planning.territory.import.select_sheet", choose: "party_planning.territory.import.choose", confirm: "party_planning.territory.import.confirm", failed: "party_planning.territory.msg.import_failed",
    rApplied: "party_planning.territory.import.result_applied", createdOne: "party_planning.territory.import.result_created_one", createdMany: "party_planning.territory.import.result_created_many", rNoChange: "party_planning.territory.import.result_no_change",
    rUnmatched: "party_planning.territory.import.result_unmatched", rAmbiguous: "party_planning.territory.import.result_ambiguous", rInvalid: "party_planning.territory.import.result_invalid", rDuplicates: "party_planning.territory.import.result_duplicates",
    sMatched: "party_planning.territory.import.sum_matched", sUnmatched: "party_planning.territory.import.sum_unmatched", sAmbiguous: "party_planning.territory.import.sum_ambiguous", sToResolve: "party_planning.territory.import.sum_to_resolve", sInvalid: "party_planning.territory.import.sum_invalid",
    sDuplicates: "party_planning.territory.import.sum_duplicates", sNoChange: "party_planning.territory.import.sum_no_change", sNewMarkets: "party_planning.territory.import.sum_new_markets", sDistrict: "party_planning.territory.import.sum_district_updates", sWillApply: "party_planning.territory.import.sum_will_apply",
    gMatched: "party_planning.territory.import.group_matched", gAmbiguous: "party_planning.territory.import.group_ambiguous", gUnmatched: "party_planning.territory.import.group_unmatched", gInvalid: "party_planning.territory.import.group_invalid",
    cExcelDealer: "party_planning.territory.import.col_excel_dealer", cMatchedParty: "party_planning.territory.import.col_matched_party", cCurDistrict: "party_planning.territory.import.col_current_district", cExcelDistrict: "party_planning.territory.import.col_excel_district",
    cCurMarket: "party_planning.territory.import.col_current_market", cExcelMarket: "party_planning.territory.import.col_excel_market", cResult: "party_planning.territory.import.col_result", cDistrictMarket: "party_planning.territory.import.col_district_market",
    cPossible: "party_planning.territory.import.col_possible", cExcelRow: "party_planning.territory.import.col_excel_row", cDealerDistrictMarket: "party_planning.territory.import.col_dealer_district_market", cReason: "party_planning.territory.import.col_reason",
    badgeNew: "party_planning.territory.import.badge_new", notInSheet: "party_planning.territory.import.not_in_sheet", resolved: "party_planning.territory.import.resolved", needsChoice: "party_planning.territory.import.needs_choice",
    chMarketUpdated: "party_planning.territory.import.change_market_updated", chMarketAdded: "party_planning.territory.import.change_market_added", chDistrictAdded: "party_planning.territory.import.change_district_added", chDistrictUpdated: "party_planning.territory.import.change_district_updated", chNone: "party_planning.territory.import.change_none",
    MATCHED: "party_planning.territory.import.status_matched", UNMATCHED: "party_planning.territory.import.status_unmatched", AMBIGUOUS: "party_planning.territory.import.status_ambiguous", INVALID: "party_planning.territory.import.status_invalid", DUPLICATE: "party_planning.territory.import.status_duplicate", CONFLICT: "party_planning.territory.import.status_conflict",
    close: "party_planning.common.close", cancel: "party_planning.common.cancel", applying: "party_planning.common.applying" });
  const changeText = (r: ImportPlanRow): string => {
    const parts: string[] = [];
    if (r.marketChanged) parts.push(r.currentMarket ? fill(T.chMarketUpdated, { market: r.currentMarket }) : T.chMarketAdded);
    if (r.districtAction === "ADD") parts.push(T.chDistrictAdded);
    if (r.districtAction === "CHANGE") parts.push(fill(T.chDistrictUpdated, { district: r.currentDistrict }));
    return parts.length ? parts.join("; ") : T.chNone;
  };

  const previewMut = useMutation({
    mutationFn: (v: { file: File; sheet: string | null }) => postImport<ImportPreview>("/api/territory-mapping/import/preview", v.file, v.sheet, T.failed),
    onSuccess: (p) => { setError(null); setPreview(p); setSheet(p.sheet); setPicks({}); },
    onError: (e) => setError((e as Error).message),
  });
  const commitMut = useMutation({
    mutationFn: () => postImport<ImportResult>("/api/territory-mapping/import/commit", file!, sheet, T.failed, picks),
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
        <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
        {result ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">{T.applied}</p>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>{fill(T.rApplied, { count: result.applied })}{result.marketsCreated ? (result.marketsCreated === 1 ? T.createdOne : fill(T.createdMany, { count: result.marketsCreated })) : ""}</li>
              <li>{fill(T.rNoChange, { count: result.noChange })}</li>
              <li>{fill(T.rUnmatched, { count: result.skippedUnmatched })}</li>
              <li>{fill(T.rAmbiguous, { count: result.skippedAmbiguous })}</li>
              <li>{fill(T.rInvalid, { count: result.rejectedInvalid })}</li>
              <li>{fill(T.rDuplicates, { count: result.duplicates })}</li>
            </ul>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{fillNodes(T.fileLabel, { dealer: <b>Dealer</b>, market: <b>Market</b>, district: <b>District</b> })}</Label>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="block text-sm"
                onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setPreview(null); setSheet(null); setError(null); if (f) previewMut.mutate({ file: f, sheet: null }); }} />
              <p className="text-xs text-muted-foreground">{T.note}</p>
            </div>
            {preview && preview.sheetNames.length > 1 && (
              <div className="space-y-1.5"><Label>{T.sheet}</Label>
                <NativeSelect className="w-64" value={sheet ?? ""} placeholder={T.selectSheet} options={preview.sheetNames.map((n) => ({ value: n, label: n }))}
                  onChange={(e) => { setSheet(e.target.value || null); if (file && e.target.value) previewMut.mutate({ file, sheet: e.target.value }); }} />
              </div>
            )}
            {previewMut.isPending && <Skeleton className="h-16 w-full" />}
            {preview?.error && <p className="text-sm text-destructive">{preview.error}</p>}
            {preview?.summary && (
              <div className="space-y-4">
                <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-4">
                  <span>{T.sMatched}: <b>{preview.summary.matched}</b></span><span>{T.sUnmatched}: <b>{preview.summary.unmatched}</b></span>
                  <span>{T.sAmbiguous}: <b>{preview.summary.ambiguous}</b> {fill(T.sToResolve, { count: unresolved })}</span><span>{T.sInvalid}: <b>{preview.summary.invalid + preview.summary.conflicts}</b></span>
                  <span>{T.sDuplicates}: <b>{preview.summary.duplicates}</b></span><span>{T.sNoChange}: <b>{preview.summary.noChange}</b></span>
                  <span>{T.sNewMarkets}: <b>{preview.summary.newMarkets}</b></span><span>{T.sDistrict}: <b>{preview.summary.districtUpdates}</b></span><span>{T.sWillApply}: <b>{willApply}</b></span>
                </div>
                <PlanTable title={T.gMatched} rows={group("MATCHED")} render={(r) => (
                  <><TableCell>{r.excelDealer}</TableCell><TableCell>{r.partyName}</TableCell>
                    <TableCell>{r.currentDistrict || "—"}</TableCell>
                    <TableCell>{r.districtName || <span className="text-muted-foreground">{T.notInSheet}</span>}</TableCell>
                    <TableCell>{r.currentMarket || "—"}</TableCell>
                    <TableCell>{r.marketName}{r.newMarket && <Badge variant="secondary" className="ml-2">{T.badgeNew}</Badge>}</TableCell>
                    <TableCell>{changeText(r)}</TableCell></>
                )} head={[T.cExcelDealer, T.cMatchedParty, T.cCurDistrict, T.cExcelDistrict, T.cCurMarket, T.cExcelMarket, T.cResult]} />
                <PlanTable title={T.gAmbiguous} rows={group("AMBIGUOUS")} head={[T.cExcelDealer, T.cDistrictMarket, T.cPossible, T.cResult]} render={(r) => (
                  <><TableCell>{r.excelDealer}</TableCell><TableCell>{districtMarket(r)}</TableCell>
                    <TableCell><NativeSelect className="h-8" value={picks[r.rowNumber] ?? ""} placeholder={T.choose}
                      options={(r.candidates ?? []).map((c) => ({ value: c.dealerId, label: c.partyName }))}
                      onChange={(e) => setPicks((p) => { const next = { ...p }; if (e.target.value) next[r.rowNumber] = e.target.value; else delete next[r.rowNumber]; return next; })} /></TableCell>
                    <TableCell>{picks[r.rowNumber] ? T.resolved : T.needsChoice}</TableCell></>
                )} />
                <PlanTable title={T.gUnmatched} rows={group("UNMATCHED")} head={[T.cExcelDealer, T.cDistrictMarket, T.cResult]} render={(r) => (<><TableCell>{r.excelDealer}</TableCell><TableCell>{districtMarket(r)}</TableCell><TableCell>{r.reason}</TableCell></>)} />
                <PlanTable title={T.gInvalid} rows={plan.filter((r) => ["INVALID", "CONFLICT", "DUPLICATE"].includes(r.status))} head={[T.cExcelRow, T.cDealerDistrictMarket, T.cReason]}
                  render={(r) => (<><TableCell>{r.rowNumber} <Badge variant="muted" className="ml-1">{T[r.status]}</Badge></TableCell><TableCell>{r.excelDealer || "—"} · {r.excelDistrict || "—"} · {r.excelMarket || "—"}</TableCell><TableCell>{r.reason}</TableCell></>)} />
              </div>
            )}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{result ? T.close : T.cancel}</Button>
          {!result && <Button disabled={!preview?.summary || willApply === 0 || commitMut.isPending} onClick={() => commitMut.mutate()}><Check className="h-4 w-4" /> {commitMut.isPending ? T.applying : fill(T.confirm, { count: willApply })}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const dateTimeFull = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/**
 * TEMPORARY: the Market of an Existing Dealer is a free-text value the user can correct. Click → edit → Save → confirmation naming the dealer,
 * the current and the new Market → saved with its history. "Edited" (shown once any manual change exists) opens that dealer's full history.
 * This is not a Market master record; Seasonal / Monthly Planning keep their own searchable Market selectors.
 */
function MarketCell({ row, label, onError }: { row: DealerRow; label: string; onError: (message: string | null) => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState(false);
  const current = row.marketName ?? "";
  const T = useLabels({ save: "party_planning.common.save", cancel: "party_planning.common.cancel", edit: "party_planning.territory.aria.edit_market", edited: "party_planning.territory.badge.edited", title: "party_planning.territory.dialog.change_title",
    dealer: "party_planning.territory.dialog.dealer", currentMarket: "party_planning.territory.dialog.current_market", newMarket: "party_planning.territory.dialog.new_market", saving: "party_planning.common.saving", confirm: "party_planning.territory.dialog.confirm_change" });
  const change = useMutation({
    mutationFn: () => api.post(`/api/territory-mapping/dealers/${row.dealerId}/market`, { expectedMarket: row.marketName, market: draft }),
    onSuccess: () => { onError(null); setConfirming(false); setEditing(false); qc.invalidateQueries({ queryKey: ["territory-dealers"] }); qc.invalidateQueries({ queryKey: ["territory-market-history", row.dealerId] }); },
    onError: (e) => { setConfirming(false); setEditing(false); onError((e as Error).message); qc.invalidateQueries({ queryKey: ["territory-dealers"] }); },
  });
  const unchanged = !draft.trim() || draft.trim().replace(/\s+/g, " ").toLowerCase() === current.toLowerCase();
  return (
    <div className="flex items-center gap-2 px-2">
      {editing ? (
        <>
          <Input className="h-8 min-w-[12rem] flex-1" aria-label={label} value={draft} maxLength={120} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !unchanged) setConfirming(true); if (e.key === "Escape") setEditing(false); }} />
          <Button size="sm" className="shrink-0" disabled={unchanged} onClick={() => setConfirming(true)}>{T.save}</Button>
          <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setEditing(false)}>{T.cancel}</Button>
        </>
      ) : (
        <>
          <button type="button" className="rounded px-1 py-1 text-left hover:bg-muted" aria-label={fill(T.edit, { label })} onClick={() => { setDraft(current); setEditing(true); }}>{row.marketName ?? <span className="text-muted-foreground">—</span>}</button>
          {row.marketEdited && <button type="button" onClick={() => setHistory(true)} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground hover:text-foreground">{T.edited}</button>}
        </>
      )}
      {confirming && (
        <Dialog open onOpenChange={(o) => { if (!o && !change.isPending) setConfirming(false); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-muted-foreground">{T.dealer}</dt><dd className="font-medium">{row.partyName}</dd></div>
              <div><dt className="text-muted-foreground">{T.currentMarket}</dt><dd className="font-medium">{row.marketName ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">{T.newMarket}</dt><dd className="font-medium">{draft.trim().replace(/\s+/g, " ")}</dd></div>
            </dl>
            <DialogFooter>
              <Button variant="outline" disabled={change.isPending} onClick={() => setConfirming(false)}>{T.cancel}</Button>
              <Button disabled={change.isPending} onClick={() => change.mutate()}>{change.isPending ? T.saving : T.confirm}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {history && <MarketHistoryDialog dealerId={row.dealerId} onClose={() => setHistory(false)} />}
    </div>
  );
}

function MarketHistoryDialog({ dealerId, onClose }: { dealerId: string; onClose: () => void }) {
  const T = useLabels({ title: "party_planning.territory.history.title", dealer: "party_planning.territory.dialog.dealer", previous: "party_planning.territory.history.previous", new: "party_planning.territory.history.new", by: "party_planning.territory.history.edited_by", at: "party_planning.territory.history.date_time", close: "party_planning.common.close" });
  const { data, isLoading, error } = useQuery<{ dealerName: string; edits: { id: string; previousMarket: string | null; newMarket: string; editedByName: string; editedAt: string }[] }>({
    queryKey: ["territory-market-history", dealerId], queryFn: () => api.get(`/api/territory-mapping/dealers/${dealerId}/market-history`),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
        {isLoading ? <Skeleton className="h-16 w-full" /> : error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : (
          <div className="space-y-3 text-sm">
            <div><span className="text-muted-foreground">{T.dealer}</span><div className="font-medium">{data!.dealerName}</div></div>
            <ol className="space-y-3">
              {data!.edits.map((e, i) => (
                <li key={e.id} className="rounded-md border p-3">
                  <div className="font-medium">{i + 1}.</div>
                  <div>{fill(T.previous, { value: e.previousMarket ?? "—" })}</div><div>{fill(T.new, { value: e.newMarket })}</div>
                  <div>{fill(T.by, { value: e.editedByName })}</div><div>{fill(T.at, { value: dateTimeFull(e.editedAt) })}</div>
                </li>
              ))}
            </ol>
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>{T.close}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const districtMarket = (r: ImportPlanRow) => `${r.excelDistrict || "—"} · ${r.excelMarket || "—"}`;

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

export function AddMarket({ role }: { role: Role }) {
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
  const [adding, setAdding] = useState(false);
  const L = {
    name: useLabel("party_planning.territory.field.market_name"), potential: useLabel("party_planning.territory.field.market_potential"),
    parties: useLabel("party_planning.territory.field.number_of_parties"), send: useLabel("party_planning.territory.action.send_request"),
  };
  const T = useLabels({ sent: "party_planning.territory.msg.request_sent", review: "party_planning.territory.view.review", mine: "party_planning.territory.view.mine", history: "party_planning.territory.view.history", requestedBy: "party_planning.common.requested_by",
    date: "party_planning.territory.col.date", status: "party_planning.territory.col.status", decision: "party_planning.common.decision", action: "party_planning.territory.col.action", empty: "party_planning.territory.empty_requests", select: "party_planning.territory.placeholder.select",
    addMarket: "party_planning.action.add_market", approve: "party_planning.action.approve", reject: "party_planning.action.reject", cancel: "party_planning.common.cancel", decidedRm: "party_planning.common.decided_rm", decidedAdmin: "party_planning.common.decided_admin", rejectedBy: "party_planning.common.rejected_by",
    PENDING_RM: "party_planning.status.awaiting_rm", PENDING_ADMIN: "party_planning.status.awaiting_admin", APPROVED: "party_planning.status.approved", REJECTED: "party_planning.status.rejected" });
  const send = useMutation({
    mutationFn: () => api.post<MarketRequest>("/api/territory-mapping/market-requests", { marketName: name, potential, numberOfParties: parties }),
    onSuccess: () => { setError(null); setNotice(T.sent); setName(""); setPotential(""); setParties(""); setAdding(false); setView("mine"); qc.invalidateQueries({ queryKey: ["market-requests"] }); },
    onError: (e) => { setNotice(null); setError((e as Error).message); },
  });
  const closeForm = () => { setAdding(false); setName(""); setPotential(""); setParties(""); setError(null); }; // Cancel: nothing is sent
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
    ...(canReview ? [{ key: "review" as const, label: T.review }] : []),
    ...(canRequest ? [{ key: "mine" as const, label: T.mine }] : []),
    { key: "history" as const, label: T.history },
  ];

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
          {views.map((v) => (
            <button key={v.key} onClick={() => setView(v.key)} className={`rounded px-3 py-1.5 font-medium ${view === v.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{v.label}</button>
          ))}
        </div>
        {(!canRequest || !adding) && error && <p className="text-sm text-destructive">{error}</p>}
        {notice && !adding && <p className="text-sm text-success">{notice}</p>}
        <div className="overflow-auto rounded-lg border bg-background">
          <Table>
            <TableHeader><TableRow>
              <TableHead>{L.name}</TableHead><TableHead>{L.potential}</TableHead><TableHead>{L.parties}</TableHead><TableHead>{T.requestedBy}</TableHead><TableHead>{T.date}</TableHead><TableHead>{T.status}</TableHead><TableHead>{T.decision}</TableHead>
              {view === "review" && <TableHead className="text-right">{T.action}</TableHead>}
            </TableRow></TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                : (requests?.length ?? 0) === 0 ? <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">{T.empty}</TableCell></TableRow>
                  : requests!.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.marketName}</TableCell><TableCell>{r.potential}</TableCell><TableCell>{r.numberOfParties}</TableCell>
                      <TableCell>{r.requesterName}</TableCell><TableCell className="whitespace-nowrap">{dateText(r.createdAt)}</TableCell>
                      <TableCell><Badge variant={REQUEST_VARIANT[r.status]}>{T[r.status]}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.rmDecidedByName && <div>{fill(T.decidedRm, { name: r.rmDecidedByName, date: dateText(r.rmDecidedAt) })}</div>}
                        {r.adminDecidedByName && <div>{fill(T.decidedAdmin, { name: r.adminDecidedByName, date: dateText(r.adminDecidedAt) })}</div>}
                        {r.rejectionReason && <div className="text-destructive">{fill(T.rejectedBy, { stage: r.rejectionStage, reason: r.rejectionReason })}</div>}
                        {!r.rmDecidedByName && !r.adminDecidedByName && dash}
                      </TableCell>
                      {view === "review" && (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: "approve" })}><Check className="h-4 w-4" /> {T.approve}</Button>
                            <Button size="sm" variant="ghost" className="text-destructive" disabled={act.isPending} onClick={() => setRejecting(r)}><X className="h-4 w-4" /> {T.reject}</Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
          {canRequest && <div className="border-t p-2"><Button variant="outline" size="sm" onClick={() => { setNotice(null); setError(null); setAdding(true); }}>{`+ ${T.addMarket}`}</Button></div>}
        </div>
      </div>
      {adding && (
        <Dialog open onOpenChange={(o) => { if (!o && !send.isPending) closeForm(); }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{T.addMarket}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5"><Label>{L.name} *</Label><Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5"><Label>{L.potential} *</Label>
                  <NativeSelect value={potential} placeholder={T.select} options={POTENTIALS.map((p) => ({ value: p, label: p }))} onChange={(e) => setPotential(e.target.value)} />
                </div>
                <div className="space-y-1.5"><Label>{L.parties} *</Label>
                  <Input type="number" min={1} step={1} inputMode="numeric" value={parties} onChange={(e) => setParties(e.target.value)} />
                </div>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={send.isPending} onClick={closeForm}>{T.cancel}</Button>
              <Button disabled={send.isPending} onClick={submit}>{L.send}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {rejecting && <RejectDialog request={rejecting} pending={act.isPending} error={error} onCancel={() => setRejecting(null)} onConfirm={(reason) => act.mutate({ id: rejecting.id, action: "reject", reason })} />}
    </div>
  );
}

function RejectDialog({ request, pending, error, onCancel, onConfirm }: { request: MarketRequest; pending: boolean; error: string | null; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const T = useLabels({ title: "party_planning.common.reject_title", reason: "party_planning.common.reason", cancel: "party_planning.common.cancel", reject: "party_planning.action.reject" });
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{fill(T.title, { name: request.marketName })}</DialogTitle></DialogHeader>
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
