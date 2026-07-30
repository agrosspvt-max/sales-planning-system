"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import type { Paginated } from "@/lib/pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface AuditRow {
  id: string;
  userName: string;
  action: string;
  entity: string;
  entityId: string | null;
  summary: string | null;
  createdAt: string;
}
interface Options {
  entities: string[];
  actions: string[];
  users: { id: string; name: string }[];
}

export function AuditPage() {
  const [filters, setFilters] = useState({ user: "", entity: "", action: "", from: "", to: "" });
  const [page, setPage] = useState(1);

  const { data: options } = useQuery<Options>({
    queryKey: ["audit-options"],
    queryFn: () => api.get<Options>("/api/audit?options=1"),
  });

  const qs = new URLSearchParams({
    page: String(page),
    ...(filters.user ? { user: filters.user } : {}),
    ...(filters.entity ? { entity: filters.entity } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  }).toString();

  const { data, isLoading } = useQuery<Paginated<AuditRow>>({
    queryKey: ["audit", qs],
    queryFn: () => api.get<Paginated<AuditRow>>(`/api/audit?${qs}`),
  });

  function set<K extends keyof typeof filters>(k: K, v: string) {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Audit Logs" subtitle="Immutable record of changes across the system." />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="User">
          <NativeSelect
            className="w-44"
            placeholder="All"
            options={(options?.users ?? []).map((u) => ({ value: u.id, label: u.name }))}
            value={filters.user}
            onChange={(e) => set("user", e.target.value)}
          />
        </Field>
        <Field label="Module">
          <NativeSelect
            className="w-40"
            placeholder="All"
            options={(options?.entities ?? []).map((e) => ({ value: e, label: e }))}
            value={filters.entity}
            onChange={(e) => set("entity", e.target.value)}
          />
        </Field>
        <Field label="Action">
          <NativeSelect
            className="w-36"
            placeholder="All"
            options={(options?.actions ?? []).map((a) => ({ value: a, label: a }))}
            value={filters.action}
            onChange={(e) => set("action", e.target.value)}
          />
        </Field>
        <Field label="From">
          <Input type="date" className="w-40" value={filters.from} onChange={(e) => set("from", e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" className="w-40" value={filters.to} onChange={(e) => set("to", e.target.value)} />
        </Field>
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Module</TableHead>
              <TableHead>Summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ) : (data?.items.length ?? 0) === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  No activity for the selected filters.
                </TableCell>
              </TableRow>
            ) : (
              data!.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDate(r.createdAt)}
                  </TableCell>
                  <TableCell>{r.userName}</TableCell>
                  <TableCell>{r.action}</TableCell>
                  <TableCell>{r.entity}</TableCell>
                  <TableCell className="text-muted-foreground">{r.summary ?? r.entityId ?? "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {data.page} of {data.totalPages} · {data.total} total
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
