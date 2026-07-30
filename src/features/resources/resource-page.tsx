"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Ban, RotateCcw, Search } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatCell } from "@/lib/format";
import type { Paginated } from "@/lib/pagination";
import type { ResourceClientConfig } from "./config";
import { ResourceForm } from "./resource-form";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Row = Record<string, unknown> & { id: string; isActive?: boolean };

export function ResourcePage({
  config,
  canWrite,
}: {
  config: ResourceClientConfig;
  canWrite: boolean;
}) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<Row | null>(null);

  const queryKey = ["resource", config.key, page, search];
  const { data, isLoading } = useQuery<Paginated<Row>>({
    queryKey,
    queryFn: () =>
      api.get<Paginated<Row>>(
        `/api/resources/${config.key}?page=${page}&search=${encodeURIComponent(search)}`,
      ),
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["resource", config.key] });
  }

  const createMut = useMutation({
    mutationFn: (values: Record<string, string>) => api.post(`/api/resources/${config.key}`, values),
    onSuccess: invalidate,
  });
  const updateMut = useMutation({
    mutationFn: (vars: { id: string; values: Record<string, string> }) =>
      api.patch(`/api/resources/${config.key}/${vars.id}`, vars.values),
    onSuccess: invalidate,
  });
  const statusMut = useMutation({
    mutationFn: (vars: { id: string; isActive: boolean }) =>
      api.post(`/api/resources/${config.key}/${vars.id}/status`, { isActive: vars.isActive }),
    onSuccess: invalidate,
  });

  const items = data?.items ?? [];
  const colSpan = config.columns.length + 1;

  return (
    <div className="space-y-4">
      <PageHeader
        title={config.label}
        subtitle={`Manage ${config.label.toLowerCase()}.`}
        actions={
          canWrite ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> New {config.singular}
            </Button>
          ) : undefined
        }
      />

      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder={config.searchPlaceholder}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              {config.columns.map((c) => (
                <TableHead key={c.key}>{c.label}</TableHead>
              ))}
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={colSpan}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-10 text-center text-muted-foreground">
                  No {config.label.toLowerCase()} found.
                </TableCell>
              </TableRow>
            ) : (
              items.map((row) => {
                const active = row.isActive !== false;
                return (
                  <TableRow key={row.id} className={active ? "" : "opacity-60"}>
                    {config.columns.map((c) => {
                      const p = config.profile;
                      const isProfileCell =
                        p?.column === c.key &&
                        (!p.onlyWhen || row[p.onlyWhen.field] === p.onlyWhen.equals);
                      return (
                        <TableCell key={c.key}>
                          {c.format === "boolean" ? (
                            <Badge variant={row[c.key] ? "success" : "muted"}>
                              {formatCell(row[c.key], c.format)}
                            </Badge>
                          ) : isProfileCell ? (
                            <Link href={`${p!.base}/${row.id}`} className="font-medium text-primary hover:underline">
                              {formatCell(row[c.key], c.format)}
                            </Link>
                          ) : (
                            formatCell(row[c.key], c.format)
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-right">
                      {canWrite && (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Edit"
                            onClick={() => {
                              setEditing(row);
                              setFormOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {config.softDelete &&
                            (active ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Deactivate"
                                onClick={() => setDeactivateTarget(row)}
                              >
                                <Ban className="h-4 w-4 text-destructive" />
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Reactivate"
                                onClick={() => statusMut.mutate({ id: row.id, isActive: true })}
                              >
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
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

      <ResourceForm
        config={config}
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editing}
        onSubmit={async (values) => {
          if (editing) await updateMut.mutateAsync({ id: editing.id, values });
          else await createMut.mutateAsync(values);
        }}
      />

      <ConfirmDialog
        open={deactivateTarget !== null}
        onOpenChange={(o) => !o && setDeactivateTarget(null)}
        title={`Deactivate ${config.singular.toLowerCase()}?`}
        description={`This ${config.singular.toLowerCase()} will be hidden from new records but preserved in history. You can reactivate it later.`}
        confirmLabel="Deactivate"
        destructive
        onConfirm={() => {
          if (deactivateTarget) statusMut.mutate({ id: deactivateTarget.id, isActive: false });
        }}
      />
    </div>
  );
}
