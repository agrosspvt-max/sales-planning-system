"use client";

import { useEffect, useState } from "react";
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
interface DealerRow { id: string; name: string; hasAlias: boolean; aliases: AliasItem[]; status: string; soCreated: boolean; createdByName: string | null; officerName: string | null; officerId: string | null; groupId: string | null; town: string | null; isActive: boolean; inActivePlan: boolean }
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

/** 4-status approval badge (PENDING_APPROVAL kept as a fallback for un-migrated rows). */
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: "muted" | "success" | "warning" | "destructive" }> = {
    PENDING: { label: "Pending", variant: "muted" },
    PENDING_APPROVAL: { label: "Pending", variant: "muted" },
    ACTIVE: { label: "Active", variant: "success" },
    INACTIVE: { label: "Inactive", variant: "warning" },
    DEFAULTER: { label: "Defaulter", variant: "destructive" },
  };
  const s = map[status] ?? { label: status, variant: "muted" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function DealerCoveragePanel() {
  const [filter, setFilter] = useState<Filter>("without");
  const [search, setSearch] = useState("");
  // Debounce the search box so we send ONE request after typing settles (search now runs server-side
  // across the full scoped dealer population, so it must go to the API rather than filter loaded rows).
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const [groupId, setGroupId] = useState(""); // "" = All Groups
  const [officerId, setOfficerId] = useState(""); // "" = All Sales Officers
  const [editId, setEditId] = useState<string | null>(null); // the dealer open in the Edit dialog

  // Dropdown sources — reuse the existing Groups + Officers endpoints (officers depend on the group).
  const { data: groups } = useQuery<GroupOpt[]>({ queryKey: ["groups"], queryFn: () => api.get("/api/groups") });
  const { data: officers } = useQuery<OfficerOpt[]>({
    queryKey: ["officers", groupId],
    queryFn: () => api.get(`/api/users/officers${groupId ? `?groupId=${groupId}` : ""}`),
  });

  // Group → Sales Officer → tab → search. ALL server-side (SQL scope + counts; search filters the full
  // scoped population BEFORE the row cap). Counts returned reflect the scope only, never the search.
  const scope = `${groupId ? `&group=${groupId}` : ""}${officerId ? `&officer=${officerId}` : ""}`;
  const searchParam = debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : "";
  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["dealer-coverage", filter, groupId, officerId, debouncedSearch],
    queryFn: () => api.get<Resp>(`/api/dealer-alias/dealers?filter=${filter}${scope}${searchParam}`),
  });

  // The dealer being edited is derived from LIVE data so the dialog reflects alias add/remove at once.
  const editRow = data?.dealers.find((d) => d.id === editId) ?? null;
  const editDealer: EditDealer | null = editRow
    ? { id: editRow.id, name: editRow.name, officerId: editRow.officerId, groupId: editRow.groupId, town: editRow.town, status: editRow.status, inActivePlan: editRow.inActivePlan, aliases: editRow.aliases }
    : null;

  // Rows are already tab-filtered AND search-filtered server-side (over the full scoped population,
  // before the row cap), so render them directly — no client-side re-filtering.
  const dealers = data?.dealers ?? [];

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
                  <TableCell><StatusBadge status={d.status} /></TableCell>
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
