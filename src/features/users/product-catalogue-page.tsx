"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, PackageCheck, Loader2, Check, X, Download, Upload, Tag } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ClearanceTag } from "@/components/ui/clearance-tag";
import { CategoryBadge } from "@/components/ui/category-badge";
import { CategoryFilter } from "@/components/ui/category-filter";
import { useCategories } from "@/lib/use-categories";
import { categoryForNbv, matchesCategoryFilter } from "@/lib/product-category";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Row { productId: string; name: string; nbvPercent: number; masterPrice: number; masterActive: boolean; groupPrice: number; isActive: boolean; priceIsInitial: boolean; isClearance: boolean; clearanceQty: number | null; clearanceSold: number; clearanceRemaining: number | null }
interface Addable { productId: string; name: string; masterPrice: number }
interface Catalogue {
  groupId: string; groupName: string;
  summary: { total: number; active: number; inactive: number; usingInitialPrice: number; clearance: number };
  rows: Row[]; addable: Addable[];
}
interface RefreshImpact {
  groupId: string; groupName: string; productId: string; currentPrice: number;
  draft: number; returned: number; submitted: number;
  approvedSeasons: { seasonId: string; seasonName: string; count: number }[];
}

/** Users → Group → Product Catalogue. Group availability + group price + active/inactive over the Master. */
export function ProductCataloguePage({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({}); // productId -> in-progress price text
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refreshProduct, setRefreshProduct] = useState<string | null>(null); // product whose price refresh modal is open
  const [clearanceFor, setClearanceFor] = useState<string[] | null>(null); // product ids to mark clearance (popup)
  const categories = useCategories();
  const [categoryFilter, setCategoryFilter] = useState("");

  const { data, isLoading } = useQuery<Catalogue>({
    queryKey: ["group-catalogue", groupId],
    queryFn: () => api.get<Catalogue>(`/api/groups/${groupId}/catalogue`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["group-catalogue", groupId] });

  const initMut = useMutation({ mutationFn: () => api.post(`/api/groups/${groupId}/catalogue/initialize`, {}), onSuccess: invalidate });
  const uploadMut = useMutation({
    mutationFn: async (v: { file: File; createMissingMaster: boolean }) => {
      const fd = new FormData();
      fd.append("file", v.file);
      fd.append("createMissingMaster", v.createMissingMaster ? "true" : "false");
      const res = await fetch(`/api/groups/${groupId}/catalogue/excel`, { method: "POST", body: fd });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Upload failed");
      return body as { updated: number; added: number; createdMaster: number; needsMaster: string[]; skipped: number; errors: string[] };
    },
    onSuccess: (r, vars) => {
      invalidate();
      if (r.needsMaster.length > 0 && !vars.createMissingMaster) {
        const list = r.needsMaster.slice(0, 20).join(", ");
        if (confirm(`${r.updated} updated, ${r.added} added.\n\n${r.needsMaster.length} product(s) are not in the Master Catalogue:\n${list}\n\nCreate them as new Master products AND add to this group?`)) {
          uploadMut.mutate({ file: vars.file, createMissingMaster: true });
          return;
        }
      }
      alert(`Catalogue upload: ${r.updated} updated, ${r.added} added, ${r.createdMaster} created${r.errors.length ? `, ${r.errors.length} errors` : ""}.`);
    },
    onError: (e) => alert((e as Error).message),
  });
  const patchMut = useMutation({
    mutationFn: (v: { productId: string; price?: number; isActive?: boolean }) => api.patch<{ ok: boolean; priceChanged?: boolean }>(`/api/groups/${groupId}/catalogue/${v.productId}`, { price: v.price, isActive: v.isActive }),
    onSuccess: (r, v) => {
      invalidate();
      // Explicit refresh: a price change offers the "Price Update Impact" modal (never auto-applied).
      if (r?.priceChanged) setRefreshProduct(v.productId);
    },
    onError: (e) => alert((e as Error).message),
  });
  const clearanceMut = useMutation({
    mutationFn: (v: { productIds: string[]; clearanceQty: number | null }) => api.post(`/api/groups/${groupId}/catalogue/clearance`, v),
    onSuccess: () => { invalidate(); setSelected(new Set()); setClearanceFor(null); },
    onError: (e) => alert((e as Error).message),
  });
  const removeClearanceMut = useMutation({
    mutationFn: async (productIds: string[]) => {
      const res = await fetch(`/api/groups/${groupId}/catalogue/clearance`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productIds }) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      return res.json();
    },
    onSuccess: () => { invalidate(); setSelected(new Set()); },
    onError: (e) => alert((e as Error).message),
  });

  const savePrice = (r: Row) => {
    const raw = edits[r.productId];
    const price = Number(raw);
    if (raw === undefined || !Number.isFinite(price) || price < 0) return;
    patchMut.mutate({ productId: r.productId, price });
    setEdits((m) => { const n = { ...m }; delete n[r.productId]; return n; });
  };
  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: "State Catalogue", href: "/masters/product-catalogue" }, { label: data?.groupName ?? "Group" }]}
        title={`${data?.groupName ?? "Group"} — State Catalogue`}
        subtitle="Group availability and pricing over the Master Product. Master stays the single product identity."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild><Link href="/masters/users"><ArrowLeft className="h-4 w-4" /> Back</Link></Button>
            <Button variant="outline" size="sm" disabled={initMut.isPending} onClick={() => initMut.mutate()}>
              {initMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />} Initialize From Master
            </Button>
            <Button variant="outline" size="sm" asChild>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- file-download endpoint */}
              <a href={`/api/groups/${groupId}/catalogue/excel`}><Download className="h-4 w-4" /> Download Excel</a>
            </Button>
            <Button variant="outline" size="sm" asChild disabled={uploadMut.isPending}>
              <label className="cursor-pointer">
                {uploadMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload Excel
                <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadMut.mutate({ file: f, createMissingMaster: false }); e.currentTarget.value = ""; }} />
              </label>
            </Button>
            <CategoryFilter categories={categories} value={categoryFilter} onChange={setCategoryFilter} />
            <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add Product</Button>
          </div>
        }
      />

      {isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : data.rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">This group has no product catalogue yet.</p>
            <Button disabled={initMut.isPending} onClick={() => initMut.mutate()}>
              {initMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Initializing…</> : <><PackageCheck className="h-4 w-4" /> Initialize From Master</>}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-5">
            <Stat label="Total Products" value={data.summary.total} />
            <Stat label="Active" value={data.summary.active} />
            <Stat label="Inactive" value={data.summary.inactive} />
            <Stat label="Using Initial Master Price" value={data.summary.usingInitialPrice} />
            <Stat label="Clearance" value={data.summary.clearance} />
          </div>

          {/* Multi-select bulk clearance actions. */}
          {selected.size > 0 && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2 text-sm">
              <span className="text-muted-foreground">{selected.size} selected</span>
              <Button size="sm" variant="outline" onClick={() => setClearanceFor([...selected])}><Tag className="h-4 w-4" /> Add as Clearance</Button>
              <Button size="sm" variant="outline" onClick={() => removeClearanceMut.mutate([...selected])}>Remove Clearance</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}

          <div className="overflow-auto rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Master Price</TableHead>
                  <TableHead className="text-right">Group Price</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.filter((r) => matchesCategoryFilter(r.nbvPercent, categoryFilter, categories)).map((r) => {
                  const editing = edits[r.productId] !== undefined;
                  return (
                    <TableRow key={r.productId}>
                      <TableCell><input type="checkbox" className="h-4 w-4" checked={selected.has(r.productId)} onChange={() => toggleSel(r.productId)} /></TableCell>
                      <TableCell className="font-medium">
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <span className={r.isClearance ? "text-warning" : undefined}>{r.name}</span>
                          {r.priceIsInitial && <Badge variant="muted" className="text-[10px]">Initial Master price</Badge>}
                          {r.isClearance && <ClearanceTag qty={r.clearanceQty} remaining={r.clearanceRemaining} state={data.groupName} />}
                          {!r.masterActive && <Badge variant="warning" className="text-[10px]">Master inactive</Badge>}
                        </span>
                        <div className="mt-0.5"><CategoryBadge category={categoryForNbv(r.nbvPercent, categories)} /></div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.masterPrice)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {editing ? (
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              type="number" className="h-8 w-28 text-right" value={edits[r.productId]} autoFocus
                              onChange={(e) => setEdits((m) => ({ ...m, [r.productId]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === "Enter") savePrice(r); if (e.key === "Escape") setEdits((m) => { const n = { ...m }; delete n[r.productId]; return n; }); }}
                            />
                            <Button size="sm" variant="ghost" title="Save" onClick={() => savePrice(r)}><Check className="h-4 w-4" /></Button>
                            <Button size="sm" variant="ghost" title="Cancel" onClick={() => setEdits((m) => { const n = { ...m }; delete n[r.productId]; return n; })}><X className="h-4 w-4" /></Button>
                          </div>
                        ) : (
                          <button className="tabular-nums hover:underline" onClick={() => setEdits((m) => ({ ...m, [r.productId]: String(r.groupPrice) }))} title="Edit group price">
                            {formatCurrency(r.groupPrice)}
                          </button>
                        )}
                      </TableCell>
                      <TableCell>{r.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Inactive</Badge>}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {r.isClearance ? (
                            <Button size="sm" variant="ghost" title="Remove Clearance" onClick={() => removeClearanceMut.mutate([r.productId])}><Tag className="h-4 w-4 text-warning" /></Button>
                          ) : (
                            <Button size="sm" variant="ghost" title="Add as Clearance" onClick={() => setClearanceFor([r.productId])}><Tag className="h-4 w-4" /></Button>
                          )}
                          <Button size="sm" variant="outline" disabled={patchMut.isPending} onClick={() => patchMut.mutate({ productId: r.productId, isActive: !r.isActive })}>
                            {r.isActive ? "Deactivate" : "Activate"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {data && <AddProductDialog groupId={groupId} addable={data.addable} open={addOpen} onOpenChange={setAddOpen} onDone={invalidate} />}
      {clearanceFor && <ClearanceDialog count={clearanceFor.length} pending={clearanceMut.isPending} onCancel={() => setClearanceFor(null)} onSave={(qty) => clearanceMut.mutate({ productIds: clearanceFor, clearanceQty: qty })} />}
      {refreshProduct && <RefreshPriceModal groupId={groupId} productId={refreshProduct} onClose={() => setRefreshProduct(null)} />}
    </div>
  );
}

/** Clearance quantity popup (single or bulk). */
function ClearanceDialog({ count, pending, onCancel, onSave }: { count: number; pending: boolean; onCancel: () => void; onSave: (qty: number | null) => void }) {
  const [qty, setQty] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add as Clearance {count > 1 ? `(${count} products)` : ""}</DialogTitle></DialogHeader>
        <div className="space-y-1.5">
          <Label>Clearance Quantity</Label>
          <Input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="e.g. 500 (optional)" autoFocus />
          <p className="text-xs text-muted-foreground">Clearance is group-specific and shown as a yellow tag wherever the product appears. It never affects amount/NBV calculations.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button disabled={pending} onClick={() => onSave(qty.trim() ? Math.round(Number(qty)) : null)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Price Update Impact" modal — choose which existing plans adopt the new group price. */
function RefreshPriceModal({ groupId, productId, onClose }: { groupId: string; productId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [approved, setApproved] = useState(false);
  const [seasonIds, setSeasonIds] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery<RefreshImpact>({ queryKey: ["price-impact", groupId, productId], queryFn: () => api.get<RefreshImpact>(`/api/groups/${groupId}/catalogue/${productId}/refresh`) });
  const apply = useMutation({
    mutationFn: () => api.post<{ updatedLines: number }>(`/api/groups/${groupId}/catalogue/${productId}/refresh`, { draft, submitted, approved, seasonIds: [...seasonIds] }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["group-catalogue", groupId] }); alert(`Updated ${r.updatedLines} plan line(s).`); onClose(); },
    onError: (e) => alert((e as Error).message),
  });
  const toggleSeason = (id: string) => setSeasonIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Price changed — apply to existing plans?</DialogTitle></DialogHeader>
        {isLoading || !data ? <Skeleton className="h-40 w-full" /> : (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">Group <span className="font-medium text-foreground">{data.groupName}</span> · new price <span className="font-medium text-foreground">{formatCurrency(data.currentPrice)}</span>. New plans always use the latest price. Choose which existing plans to update:</p>
            <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft / Returned plans <span className="text-muted-foreground">({data.draft + data.returned})</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4" checked={submitted} onChange={(e) => setSubmitted(e.target.checked)} /> Submitted plans <span className="text-warning">(protected — updating overrides in-review prices)</span> <span className="text-muted-foreground">({data.submitted})</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4" checked={approved} onChange={(e) => setApproved(e.target.checked)} /> Approved plans <span className="text-muted-foreground">(select seasons below)</span></label>
            {approved && (
              <div className="ml-6 space-y-1 rounded-md border p-2">
                {data.approvedSeasons.length === 0 ? <p className="text-muted-foreground">No approved plans use this product.</p> : data.approvedSeasons.map((s) => (
                  <label key={s.seasonId} className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4" checked={seasonIds.has(s.seasonId)} onChange={() => toggleSeason(s.seasonId)} /> {s.seasonName} <span className="text-muted-foreground">({s.count})</span></label>
                ))}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Not now</Button>
          <Button disabled={apply.isPending || (!draft && !submitted && !(approved && seasonIds.size > 0))} onClick={() => apply.mutate()}>Apply Update</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card><CardContent className="py-4"><div className="text-xs text-muted-foreground">{label}</div><div className="text-2xl font-semibold tabular-nums">{value}</div></CardContent></Card>
  );
}

function AddProductDialog({ groupId, addable, open, onOpenChange, onDone }: { groupId: string; addable: Addable[]; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [productId, setProductId] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = addable.find((a) => a.productId === productId);

  const addMut = useMutation({
    mutationFn: () => api.post(`/api/groups/${groupId}/catalogue`, { productId, price: price.trim() ? Number(price) : undefined }),
    onSuccess: () => { setProductId(""); setPrice(""); setError(null); onOpenChange(false); onDone(); },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Product to Catalogue</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Adds an existing Master product to this group (no duplicate product is created).</p>
          <div className="space-y-1.5">
            <Label>Master Product *</Label>
            <NativeSelect
              value={productId}
              onChange={(e) => { setProductId(e.target.value); const a = addable.find((x) => x.productId === e.target.value); setPrice(a ? String(a.masterPrice) : ""); }}
              options={[{ value: "", label: addable.length ? "Select a product…" : "All Master products are already in this group" }, ...addable.map((a) => ({ value: a.productId, label: a.name }))]}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Group Price {selected ? `(Master: ${formatCurrency(selected.masterPrice)})` : ""}</Label>
            <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Defaults to the Master price" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => addMut.mutate()} disabled={!productId || addMut.isPending}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
