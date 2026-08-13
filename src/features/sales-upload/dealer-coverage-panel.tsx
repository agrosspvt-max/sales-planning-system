"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
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
import { DealerDialog, type EditDealer } from "./create-dealer-dialog";

type Filter = "all" | "with" | "without" | "so-created" | "pending";
interface AliasItem { id: string; tallyName: string }
interface DealerRow { id: string; name: string; hasAlias: boolean; aliases: AliasItem[]; status: string; soCreated: boolean; createdByName: string | null; officerName: string | null; officerId: string | null; groupId: string | null; town: string | null; isActive: boolean }
interface Resp { counts: { all: number; with: number; without: number; soCreated: number; pending: number }; dealers: DealerRow[] }

const TABS: { key: Filter; label: string; countKey: keyof Resp["counts"] }[] = [
  { key: "all", label: "All", countKey: "all" },
  { key: "with", label: "With Alias", countKey: "with" },
  { key: "without", label: "Without Alias", countKey: "without" },
  { key: "so-created", label: "SO Created", countKey: "soCreated" },
  { key: "pending", label: "Pending", countKey: "pending" },
];

/** Dealer coverage: filter dealers by alias status, see/manage each dealer's aliases inline. */
interface GroupOpt { id: string; name: string }
interface OfficerOpt { id: string; name: string }

export function DealerCoveragePanel() {
  const [filter, setFilter] = useState<Filter>("without");
  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState(""); // "" = All Groups
  const [officerId, setOfficerId] = useState(""); // "" = All Sales Officers
  const [editId, setEditId] = useState<string | null>(null); // the dealer open in the Edit dialog

  // Dropdown sources — reuse the existing Groups + Officers endpoints (officers depend on the group).
  const { data: groups } = useQuery<GroupOpt[]>({ queryKey: ["groups"], queryFn: () => api.get("/api/groups") });
  const { data: officers } = useQuery<OfficerOpt[]>({
    queryKey: ["officers", groupId],
    queryFn: () => api.get(`/api/users/officers${groupId ? `?groupId=${groupId}` : ""}`),
  });

  // Group → Sales Officer → tab → search. Group/officer are server-side (SQL); counts reflect them.
  const scope = `${groupId ? `&group=${groupId}` : ""}${officerId ? `&officer=${officerId}` : ""}`;
  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["dealer-coverage", filter, groupId, officerId],
    queryFn: () => api.get<Resp>(`/api/dealer-alias/dealers?filter=${filter}${scope}`),
  });

  // The dealer being edited is derived from LIVE data so the dialog reflects alias add/remove at once.
  const editRow = data?.dealers.find((d) => d.id === editId) ?? null;
  const editDealer: EditDealer | null = editRow
    ? { id: editRow.id, name: editRow.name, officerId: editRow.officerId, groupId: editRow.groupId, town: editRow.town, isActive: editRow.isActive, aliases: editRow.aliases }
    : null;

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
        <div className="flex flex-wrap items-center gap-2">
          {/* Group → Sales Officer. Changing the group resets the officer to All. */}
          <NativeSelect
            className="h-9 w-40"
            value={groupId}
            onChange={(e) => { setGroupId(e.target.value); setOfficerId(""); }}
            options={[{ value: "", label: "All Groups" }, ...(groups ?? []).map((g) => ({ value: g.id, label: g.name }))]}
          />
          <NativeSelect
            className="h-9 w-48"
            value={officerId}
            onChange={(e) => setOfficerId(e.target.value)}
            options={[{ value: "", label: "All Sales Officers" }, ...(officers ?? []).map((o) => ({ value: o.id, label: o.name }))]}
          />
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
              <a href={`/api/dealer-alias/export-missing?${scope.replace(/^&/, "")}`}><Download className="h-4 w-4" /> Export Missing Alias List</a>
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
                    <Button size="sm" variant="outline" onClick={() => setEditId(d.id)}>Edit</Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* The ONE dealer dialog, in Edit Mode (same component as Create). */}
      <DealerDialog open={!!editId} onOpenChange={(o) => !o && setEditId(null)} edit={editDealer} />
    </div>
  );
}
