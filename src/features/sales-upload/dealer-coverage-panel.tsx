"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Download, Plus, Trash2, Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Filter = "all" | "with" | "without" | "so-created" | "pending";
interface AliasItem { id: string; tallyName: string }
interface DealerRow { id: string; name: string; hasAlias: boolean; aliases: AliasItem[]; status: string; soCreated: boolean; createdByName: string | null; officerName: string | null }
interface Resp { counts: { all: number; with: number; without: number; soCreated: number; pending: number }; dealers: DealerRow[] }

const TABS: { key: Filter; label: string; countKey: keyof Resp["counts"] }[] = [
  { key: "all", label: "All", countKey: "all" },
  { key: "with", label: "With Alias", countKey: "with" },
  { key: "without", label: "Without Alias", countKey: "without" },
  { key: "so-created", label: "SO Created", countKey: "soCreated" },
  { key: "pending", label: "Pending", countKey: "pending" },
];

/** Dealer coverage: filter dealers by alias status, see/manage each dealer's aliases inline. */
export function DealerCoveragePanel() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("without");
  const [search, setSearch] = useState("");
  const [manageId, setManageId] = useState<string | null>(null);
  const [newTally, setNewTally] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["dealer-coverage", filter],
    queryFn: () => api.get<Resp>(`/api/dealer-alias/dealers?filter=${filter}`),
  });

  // The dealer being managed is derived from live data so the dialog reflects add/edit/delete at once.
  const manageDealer = data?.dealers.find((d) => d.id === manageId) ?? null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dealer-coverage"] });
    qc.invalidateQueries({ queryKey: ["dealer-alias"] });
  };
  const addMut = useMutation({
    mutationFn: () => api.post("/api/dealer-alias/single", { systemDealerId: manageId, tallyName: newTally.trim() }),
    onSuccess: () => { setNewTally(""); setError(null); refresh(); },
    onError: (e) => setError((e as Error).message),
  });
  const editMut = useMutation({
    mutationFn: (v: { id: string; tallyName: string }) => api.patch(`/api/dealer-alias/${v.id}`, { tallyName: v.tallyName }),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e) => setError((e as Error).message),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => api.del(`/api/dealer-alias/${id}`),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e) => setError((e as Error).message),
  });

  const openManage = (d: DealerRow) => { setManageId(d.id); setNewTally(""); setEdits({}); setError(null); };
  const closeManage = () => { setManageId(null); setNewTally(""); setEdits({}); setError(null); };

  // Client-side search across the loaded dealers: matches the System Dealer name OR any alias name
  // (case-insensitive, partial). Filter tabs and search compose.
  const dealers = useMemo(() => {
    const rows = data?.dealers ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (d) => d.name.toLowerCase().includes(q) || d.aliases.some((a) => a.tallyName.toLowerCase().includes(q)),
    );
  }, [data?.dealers, search]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Dealer coverage</h3>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search dealer or alias…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-56 pl-8"
            />
          </div>
          {filter === "without" && (
            <Button asChild variant="outline" size="sm">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API file-download endpoint, not a page route */}
              <a href="/api/dealer-alias/export-missing"><Download className="h-4 w-4" /> Export Missing Alias List</a>
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={cn("rounded-md border px-3 py-1.5 font-medium", filter === t.key ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {t.label} {data ? `(${data.counts[t.countKey]})` : ""}
          </button>
        ))}
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Dealer</TableHead>
              <TableHead>Alias(es)</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : dealers.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">{search.trim() ? "No dealers match your search." : "No dealers in this filter."}</TableCell></TableRow>
            ) : (
              dealers.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">
                    {d.name}
                    {/* Owning Sales Officer for EVERY dealer (from the stored assignment). */}
                    {d.officerName && <span className="ml-2 text-xs font-normal text-muted-foreground">— {d.officerName}</span>}
                    {d.soCreated && <Badge variant="secondary" className="ml-2 text-[10px]">SO CREATED{d.createdByName ? ` • ${d.createdByName}` : ""}</Badge>}
                  </TableCell>
                  <TableCell>
                    {d.aliases.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {d.aliases.map((a) => (
                          <Badge key={a.id} variant="success" className="font-normal">{a.tallyName}</Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{d.status === "PENDING_APPROVAL" ? <Badge variant="muted">Pending</Badge> : <span className="text-muted-foreground">Active</span>}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => openManage(d)}>
                      {d.hasAlias ? "Edit Alias" : "Add Alias"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!manageId} onOpenChange={(o) => !o && closeManage()}>
        <DialogContent>
          <DialogHeader><DialogTitle>Aliases for “{manageDealer?.name}”</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Tally dealer name(s) that should resolve to this system dealer. Add, edit, or remove aliases below.</p>

            {/* Existing aliases — editable + deletable. */}
            {manageDealer && manageDealer.aliases.length > 0 && (
              <div className="space-y-1.5">
                {manageDealer.aliases.map((a) => {
                  const value = edits[a.id] ?? a.tallyName;
                  const changed = value.trim() !== a.tallyName && value.trim().length > 0;
                  return (
                    <div key={a.id} className="flex items-center gap-2">
                      <Input value={value} onChange={(e) => setEdits((m) => ({ ...m, [a.id]: e.target.value }))} className="h-9" />
                      <Button size="sm" variant="outline" disabled={!changed || editMut.isPending} onClick={() => editMut.mutate({ id: a.id, tallyName: value.trim() })} title="Save">
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive" disabled={delMut.isPending} onClick={() => delMut.mutate(a.id)} title="Delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add a new alias. */}
            <div className="flex items-center gap-2">
              <Input placeholder="Add a Tally dealer name…" value={newTally} onChange={(e) => setNewTally(e.target.value)} className="h-9" />
              <Button size="sm" disabled={!newTally.trim() || addMut.isPending} onClick={() => addMut.mutate()}>
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeManage}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
