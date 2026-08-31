"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Search, Tag } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { labelCatalog, type LabelCatalogEntry, type LabelKey } from "./labels";

/**
 * Admin Labels — the ONE place to customise structural UI labels (flip/tab buttons, view buttons, table
 * column headers and nested/collapsible table column headers). Reads/writes the SAME centralized store the
 * whole app uses (`/api/labels`, resolved by `LabelProvider`), so a saved change appears everywhere the key
 * is used, for every role. Only the static label text is editable — never business/data values.
 */
export function LabelsPage() {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery<{ overrides: Record<string, string>; canEdit: boolean }>({
    queryKey: ["labels"],
    queryFn: () => api.get("/api/labels"),
  });
  const catalog = useMemo(() => labelCatalog(data?.overrides), [data?.overrides]);

  const save = useMutation({
    mutationFn: (v: { key: LabelKey; value: string }) => api.patch<{ overrides: Record<string, string> }>("/api/labels", v),
    onSuccess: (res) => {
      qc.setQueryData<{ overrides: Record<string, string>; canEdit: boolean }>(["labels"], (prev) => ({ overrides: res.overrides, canEdit: prev?.canEdit ?? true }));
    },
  });

  // Filter by module / group / default / current / key.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? catalog.filter((e) => [e.module, e.group, e.default, e.current, e.key].some((s) => s.toLowerCase().includes(q)))
    : catalog;

  // Group: module → group → entries (preserving dictionary order within a group).
  const byModule = useMemo(() => {
    const modules = new Map<string, Map<string, LabelCatalogEntry[]>>();
    for (const e of filtered) {
      if (!modules.has(e.module)) modules.set(e.module, new Map());
      const groups = modules.get(e.module)!;
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group)!.push(e);
    }
    return modules;
  }, [filtered]);

  const draftOf = (e: LabelCatalogEntry) => drafts[e.key] ?? e.current;
  const setDraft = (key: string, v: string) => setDrafts((p) => ({ ...p, [key]: v }));
  const commit = (e: LabelCatalogEntry) => {
    const v = draftOf(e).trim();
    if (v === e.current) return;
    save.mutate({ key: e.key, value: v }, { onSuccess: () => setDrafts((p) => { const n = { ...p }; delete n[e.key]; return n; }) });
  };
  const reset = (e: LabelCatalogEntry) => {
    save.mutate({ key: e.key, value: "" }, { onSuccess: () => setDrafts((p) => { const n = { ...p }; delete n[e.key]; return n; }) });
  };

  const customizedCount = catalog.filter((e) => e.customized).length;

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Master Data" }, { label: "Labels" }]}
        title="Labels"
        subtitle="Customize structural UI labels — navigation/flip buttons, view buttons and table column headers. Changes apply globally for every role. Data values are never affected."
        actions={
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search labels…" className="w-64 pl-8" />
          </div>
        }
      />

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Tag className="h-4 w-4" /> {catalog.length} labels · {customizedCount} customized
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">No labels match “{query}”.</div>
      ) : (
        [...byModule.entries()].map(([module, groups]) => (
          <div key={module} className="space-y-3">
            <h2 className="text-base font-semibold">{module}</h2>
            {[...groups.entries()].map(([group, entries]) => (
              <div key={group} className="overflow-hidden rounded-lg border bg-background">
                <div className="border-b bg-muted/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Default</TableHead>
                      <TableHead>Current label</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((e) => (
                      <TableRow key={e.key}>
                        <TableCell className="align-middle">
                          <div className="font-medium">{e.default}</div>
                          <div className="text-[11px] text-muted-foreground">{e.key}</div>
                        </TableCell>
                        <TableCell className="align-middle">
                          <div className="flex items-center gap-2">
                            <Input
                              value={draftOf(e)}
                              onChange={(ev) => setDraft(e.key, ev.target.value)}
                              onKeyDown={(ev) => { if (ev.key === "Enter") commit(e); }}
                              onBlur={() => commit(e)}
                              className="w-56"
                              maxLength={120}
                            />
                            {e.customized && <Badge variant="secondary">Customized</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="text-right align-middle">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!e.customized || save.isPending}
                            title="Reset to default"
                            onClick={() => reset(e)}
                          >
                            <RotateCcw className="h-4 w-4" /> Reset
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
