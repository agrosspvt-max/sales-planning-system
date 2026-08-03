"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Download } from "lucide-react";
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
interface DealerRow { id: string; name: string; hasAlias: boolean; status: string; soCreated: boolean }
interface Resp { counts: { all: number; with: number; without: number; soCreated: number; pending: number }; dealers: DealerRow[] }

const TABS: { key: Filter; label: string; countKey: keyof Resp["counts"] }[] = [
  { key: "all", label: "All", countKey: "all" },
  { key: "with", label: "With Alias", countKey: "with" },
  { key: "without", label: "Without Alias", countKey: "without" },
  { key: "so-created", label: "SO Created", countKey: "soCreated" },
  { key: "pending", label: "Pending", countKey: "pending" },
];

/** Dealer coverage: filter dealers by alias status and add an alias inline without leaving. */
export function DealerCoveragePanel() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("without");
  const [addFor, setAddFor] = useState<DealerRow | null>(null);
  const [tally, setTally] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["dealer-coverage", filter],
    queryFn: () => api.get<Resp>(`/api/dealer-alias/dealers?filter=${filter}`),
  });

  const addMut = useMutation({
    mutationFn: () => api.post("/api/dealer-alias/single", { systemDealerId: addFor!.id, tallyName: tally.trim() }),
    onSuccess: () => {
      setAddFor(null); setTally(""); setError(null);
      qc.invalidateQueries({ queryKey: ["dealer-coverage"] });
      qc.invalidateQueries({ queryKey: ["dealer-alias"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Dealer coverage</h3>
        {/* Export the "Without Alias" list (Dealer Name + current Sales Officer) as .xlsx. */}
        {filter === "without" && (
          <Button asChild variant="outline" size="sm">
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API file-download endpoint, not a page route */}
            <a href="/api/dealer-alias/export-missing"><Download className="h-4 w-4" /> Export Missing Alias List</a>
          </Button>
        )}
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
              <TableHead>Alias</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (data?.dealers.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No dealers in this filter.</TableCell></TableRow>
            ) : (
              data!.dealers.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">
                    {d.name}
                    {d.soCreated && <Badge variant="secondary" className="ml-2 text-[10px]">SO CREATED</Badge>}
                  </TableCell>
                  <TableCell>{d.hasAlias ? <Badge variant="success">Alias</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{d.status === "PENDING_APPROVAL" ? <Badge variant="muted">Pending</Badge> : <span className="text-muted-foreground">Active</span>}</TableCell>
                  <TableCell className="text-right">
                    {!d.hasAlias && (
                      <Button size="sm" variant="outline" onClick={() => { setAddFor(d); setTally(""); setError(null); }}>Add Alias</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!addFor} onOpenChange={(o) => !o && setAddFor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add alias for “{addFor?.name}”</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Enter the Tally dealer name that should resolve to this system dealer.</p>
            <Input placeholder="Tally dealer name" value={tally} onChange={(e) => setTally(e.target.value)} />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddFor(null)}>Cancel</Button>
            <Button onClick={() => addMut.mutate()} disabled={!tally.trim() || addMut.isPending}>Save alias</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
