"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, UserX, UserCheck, Trash2 } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface GroupOpt { id: string; name: string }
interface Opt { id: string; name: string }
interface GroupPrice { price: number; isActive: boolean; isClearance: boolean; clearanceQty: number | null }
interface Row {
  productId: string; name: string; canonicalName: string | null; technicalName: string | null; masterPrice: number; nbvPercent: number; isActive: boolean;
  categoryId: string | null; brandId: string | null; groupPrices: Record<string, GroupPrice>;
}
interface MasterData { groups: GroupOpt[]; categories: Opt[]; brands: Opt[]; products: Row[] }

/** Product Master — global products with every group's price (dynamic columns) + combined edit. */
export function ProductMasterPage() {
  const qc = useQueryClient();
  const categories = useCategories();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [editRow, setEditRow] = useState<Row | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery<MasterData>({ queryKey: ["product-master"], queryFn: () => api.get<MasterData>("/api/products/master") });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["product-master"] });

  const statusMut = useMutation({ mutationFn: (v: { id: string; isActive: boolean }) => api.post(`/api/resources/products/${v.id}/status`, { isActive: v.isActive }), onSuccess: invalidate });
  const deleteMut = useMutation({ mutationFn: (id: string) => api.del(`/api/resources/products/${id}`), onSuccess: invalidate });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.products ?? []).filter(
      (r) =>
        (!q || r.name.toLowerCase().includes(q) || (r.technicalName ?? "").toLowerCase().includes(q)) &&
        matchesCategoryFilter(r.nbvPercent, categoryFilter, categories),
    );
  }, [data, search, categoryFilter, categories]);
  const groups = data?.groups ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: "Products and Catalogues" }, { label: "Product Master" }]}
        title="Product Master"
        subtitle="Global products, Master price and NBV%, plus each group's price. Group prices save to the Group Catalogue, never to the Master price."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input className="w-56" placeholder="Search product…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <CategoryFilter categories={categories} value={categoryFilter} onChange={setCategoryFilter} />
            <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New Product</Button>
          </div>
        }
      />
      <div className="overflow-auto rounded-lg border bg-background">
        <Table stickyFirstColumn>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[160px]">Product</TableHead>
              <TableHead>Technical Name</TableHead>
              <TableHead className="text-right">Master Price</TableHead>
              {groups.map((g) => <TableHead key={g.id} className="text-right">{g.name}</TableHead>)}
              <TableHead className="text-right">NBV %</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading || !data ? (
              <TableRow><TableCell colSpan={groups.length + 6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={groups.length + 6} className="py-10 text-center text-muted-foreground">No products.</TableCell></TableRow>
            ) : (
              rows.map((r) => {
                const anyClearance = Object.values(r.groupPrices).some((gp) => gp.isClearance);
                return (
                <TableRow key={r.productId}>
                  <TableCell className="font-medium">
                    <div>
                      <span className={anyClearance ? "text-warning" : undefined}>{r.name}</span>
                      <div className="mt-0.5"><CategoryBadge category={categoryForNbv(r.nbvPercent, categories)} /></div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.technicalName ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.masterPrice)}</TableCell>
                  {groups.map((g) => {
                    const gp = r.groupPrices[g.id];
                    return (
                      <TableCell key={g.id} className="text-right tabular-nums">
                        {gp ? (
                          <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
                            <span className={gp.isActive ? "" : "text-muted-foreground line-through"}>{formatCurrency(gp.price)}</span>
                            {gp.isClearance && <ClearanceTag qty={gp.clearanceQty} state={g.name} />}
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right tabular-nums">{Math.round(r.nbvPercent * 100)}%</TableCell>
                  <TableCell>{r.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Inactive</Badge>}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" title="Edit" onClick={() => setEditRow(r)}><Pencil className="h-4 w-4" /></Button>
                      <Button size="sm" variant="ghost" title={r.isActive ? "Deactivate" : "Activate"} onClick={() => statusMut.mutate({ id: r.productId, isActive: !r.isActive })}>
                        {r.isActive ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                      </Button>
                      <Button size="sm" variant="ghost" title="Delete" onClick={() => { if (confirm(`Delete ${r.name}?`)) deleteMut.mutate(r.productId); }}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {editRow && data && <EditProductDialog row={editRow} groups={data.groups} onClose={() => setEditRow(null)} onSaved={() => { setEditRow(null); invalidate(); }} />}
      {createOpen && data && <CreateProductDialog onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); invalidate(); }} />}
    </div>
  );
}

function EditProductDialog({ row, groups, onClose, onSaved }: { row: Row; groups: GroupOpt[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(row.name);
  const [canonicalName, setCanonicalName] = useState(row.canonicalName ?? "");
  const [technicalName, setTechnicalName] = useState(row.technicalName ?? "");
  const [nbvPct, setNbvPct] = useState(String(Math.round(row.nbvPercent * 10000) / 100)); // percent
  const [masterPrice, setMasterPrice] = useState(String(row.masterPrice));
  const [groupPrices, setGroupPrices] = useState<Record<string, string>>(() => Object.fromEntries(groups.map((g) => [g.id, row.groupPrices[g.id] ? String(row.groupPrices[g.id].price) : ""])));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const gp: Record<string, number> = {};
      for (const g of groups) { const v = groupPrices[g.id]?.trim(); if (v !== undefined && v !== "") gp[g.id] = Number(v); }
      return api.patch(`/api/products/master/${row.productId}`, {
        name: name.trim(), canonicalName: canonicalName.trim() || null, technicalName: technicalName.trim() || null,
        nbvPercent: Number(nbvPct) / 100, masterPrice: Number(masterPrice), groupPrices: gp,
      });
    },
    onSuccess: onSaved,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit Product — {row.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Technical Name</Label><Input value={technicalName} onChange={(e) => setTechnicalName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>NBV %</Label><Input type="number" value={nbvPct} onChange={(e) => setNbvPct(e.target.value)} placeholder="e.g. 25" /><p className="text-xs text-muted-foreground">Category is set automatically from NBV%.</p></div>
            <div className="space-y-1.5"><Label>Master Price (₹)</Label><Input type="number" value={masterPrice} onChange={(e) => setMasterPrice(e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>Canonical Name <span className="font-normal text-muted-foreground">— used only for Tally / Sales Upload matching</span></Label><Input value={canonicalName} onChange={(e) => setCanonicalName(e.target.value)} placeholder="Tally's canonical spelling (e.g. ZACKER). Leave blank to keep existing matching." /></div>
          <div className="space-y-1.5">
            <Label>Group Pricing <span className="font-normal text-muted-foreground">— saves to the Group Catalogue</span></Label>
            <div className="grid grid-cols-2 gap-2">
              {groups.map((g) => (
                <div key={g.id} className="flex items-center gap-2">
                  <span className="w-16 text-sm text-muted-foreground">{g.name}</span>
                  <Input type="number" className="h-8" value={groupPrices[g.id] ?? ""} placeholder={`Master ${row.masterPrice}`} onChange={(e) => setGroupPrices((m) => ({ ...m, [g.id]: e.target.value }))} />
                </div>
              ))}
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setError(null); save.mutate(); }} disabled={!name.trim() || save.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateProductDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [canonicalName, setCanonicalName] = useState("");
  const [technicalName, setTechnicalName] = useState("");
  const [nbvPct, setNbvPct] = useState("25");
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post("/api/resources/products", {
      name: name.trim(), canonicalName: canonicalName.trim() || undefined, technicalName: technicalName.trim(),
      nbvPercent: String(Number(nbvPct) / 100), rate: rate,
    }),
    onSuccess: onSaved,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New Product</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Technical Name</Label><Input value={technicalName} onChange={(e) => setTechnicalName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>NBV %</Label><Input type="number" value={nbvPct} onChange={(e) => setNbvPct(e.target.value)} /><p className="text-xs text-muted-foreground">Category is set automatically from NBV%.</p></div>
          <div className="space-y-1.5"><Label>Master Price (₹) *</Label><Input type="number" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
          <div className="col-span-2 space-y-1.5"><Label>Canonical Name <span className="font-normal text-muted-foreground">— used only for Tally / Sales Upload matching</span></Label><Input value={canonicalName} onChange={(e) => setCanonicalName(e.target.value)} placeholder="Tally's canonical spelling (optional). Leave blank to keep existing matching." /></div>
        </div>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setError(null); create.mutate(); }} disabled={!name.trim() || !rate || create.isPending}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
