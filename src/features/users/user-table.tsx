"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2, UserX, UserCheck, UserMinus, ShieldCheck, ArrowUpCircle, ArrowDownCircle, Pencil, Check, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type UserFilter = "active" | "inactive" | "deleted" | "all";
export interface Officer {
  id: string;
  name: string;
  username: string;
  role?: string; // "SALES_OFFICER" | "REGIONAL_MANAGER" (present when the list includes managers)
  isManager?: boolean;
  isActive: boolean;
  deleted: boolean;
  groupId: string | null;
  groupName: string | null;
  territory: string | null;
  dealerCount: number;
}

/* ----------------------------- The shared table --------------------------- */

/**
 * The ONE Sales-Officer table + row actions, reused by "All Users" and by each Group detail
 * page — only the `users` data source differs. When `onRemoveFromGroup` is provided the row also
 * offers "Remove From State" (group context). Everything else (profile link, reset, de/activate,
 * delete) is identical everywhere.
 */
export function UserTable({
  users,
  isLoading,
  emptyMessage = "No Sales Officers.",
  emptyAction,
  onRefresh,
  onRemoveFromGroup,
  showGroupColumn = true,
  showRoleActions = false,
  readOnly = false,
}: {
  users: Officer[];
  isLoading?: boolean;
  emptyMessage?: string;
  emptyAction?: React.ReactNode;
  onRefresh: () => void;
  onRemoveFromGroup?: (officer: Officer) => void;
  showGroupColumn?: boolean;
  showRoleActions?: boolean; // show RM badge + promote/demote (Users page only)
  readOnly?: boolean; // hide ALL mutating actions + profile link (Regional Manager's scoped view)
}) {
  const [resetFor, setResetFor] = useState<Officer | null>(null);
  const statusMut = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => api.post(`/api/users/${v.id}/status`, { active: v.active }),
    onSuccess: onRefresh,
  });
  const deleteMut = useMutation({ mutationFn: (id: string) => api.del(`/api/users/${id}`), onSuccess: onRefresh });
  // Inline edit of Name / Territory (admin only). Partial PATCH — sends only the changed field.
  const editMut = useMutation({
    mutationFn: (v: { id: string; field: "name" | "territory"; value: string }) => api.patch(`/api/users/${v.id}`, { [v.field]: v.value }),
    onSuccess: onRefresh,
    onError: (e) => alert((e as Error).message),
  });
  const roleMut = useMutation({
    mutationFn: (v: { id: string; role: "SALES_OFFICER" | "REGIONAL_MANAGER" }) => api.post(`/api/users/${v.id}/role`, { role: v.role }),
    onSuccess: onRefresh,
    onError: (e) => alert((e as Error).message),
  });
  const colSpan = (showGroupColumn ? 6 : 5) + (readOnly ? 0 : 1);

  return (
    <div className="rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Username</TableHead>
            {showGroupColumn && <TableHead>State</TableHead>}
            <TableHead>Territory</TableHead>
            <TableHead className="text-right">Dealers</TableHead>
            <TableHead>Status</TableHead>
            {!readOnly && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={colSpan}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
          ) : users.length === 0 ? (
            <TableRow>
              <TableCell colSpan={colSpan} className="py-10 text-center">
                <div className="flex flex-col items-center gap-3">
                  <p className="text-sm text-muted-foreground">{emptyMessage}</p>
                  {emptyAction}
                </div>
              </TableCell>
            </TableRow>
          ) : (
            users.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-medium">
                  {readOnly || o.deleted ? (
                    o.name
                  ) : (
                    <InlineEditCell
                      value={o.name}
                      placeholder="Name"
                      required
                      onSave={(v) => editMut.mutateAsync({ id: o.id, field: "name", value: v })}
                      view={<Link href={`/masters/users/${o.id}`} className="hover:underline" title="View profile">{o.name}</Link>}
                    />
                  )}
                  {showRoleActions && o.isManager && (
                    <Badge variant="default" className="ml-2 gap-1"><ShieldCheck className="h-3 w-3" /> RM</Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{o.username}</TableCell>
                {showGroupColumn && <TableCell>{o.groupName ? <Badge variant="secondary">{o.groupName}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>}
                <TableCell>
                  {readOnly || o.deleted ? (
                    o.territory ?? <span className="text-muted-foreground">—</span>
                  ) : (
                    <InlineEditCell
                      value={o.territory ?? ""}
                      placeholder="Add territory"
                      onSave={(v) => editMut.mutateAsync({ id: o.id, field: "territory", value: v })}
                    />
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{o.dealerCount}</TableCell>
                <TableCell>
                  {o.deleted ? <Badge variant="destructive">Deleted</Badge> : o.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Inactive</Badge>}
                </TableCell>
                {!readOnly && <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {showRoleActions && !o.deleted && o.isActive && (
                      o.isManager ? (
                        <Button size="sm" variant="ghost" title="Demote to Sales Officer" disabled={roleMut.isPending}
                          onClick={() => { if (confirm(`Demote ${o.name} to Sales Officer?`)) roleMut.mutate({ id: o.id, role: "SALES_OFFICER" }); }}>
                          <ArrowDownCircle className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" title={o.groupId ? "Promote to Regional Manager" : "Assign a group before promoting"} disabled={roleMut.isPending || !o.groupId}
                          onClick={() => { if (confirm(`Promote ${o.name} to Regional Manager for ${o.groupName}?`)) roleMut.mutate({ id: o.id, role: "REGIONAL_MANAGER" }); }}>
                          <ArrowUpCircle className="h-4 w-4" />
                        </Button>
                      )
                    )}
                    {onRemoveFromGroup && !o.deleted && (
                      <Button size="sm" variant="ghost" title="Remove from state" onClick={() => onRemoveFromGroup(o)}><UserMinus className="h-4 w-4" /></Button>
                    )}
                    {!o.deleted && <Button size="sm" variant="ghost" title="Reset password" onClick={() => setResetFor(o)}><KeyRound className="h-4 w-4" /></Button>}
                    {!o.deleted && (o.isActive ? (
                      <Button size="sm" variant="ghost" title="Deactivate" onClick={() => statusMut.mutate({ id: o.id, active: false })}><UserX className="h-4 w-4" /></Button>
                    ) : (
                      <Button size="sm" variant="ghost" title="Activate" onClick={() => statusMut.mutate({ id: o.id, active: true })}><UserCheck className="h-4 w-4" /></Button>
                    ))}
                    {!o.deleted && <Button size="sm" variant="ghost" title="Delete" onClick={() => { if (confirm(`Soft-delete ${o.name}? History is kept.`)) deleteMut.mutate(o.id); }}><Trash2 className="h-4 w-4" /></Button>}
                  </div>
                </TableCell>}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <ResetPasswordDialog officer={resetFor} onClose={() => setResetFor(null)} />
    </div>
  );
}

/**
 * Click-to-edit cell. Shows the value (or a custom `view`, e.g. a profile link) with a pencil affordance;
 * clicking the pencil turns it into an input with Save (✓) / Cancel (✕). Enter saves, Escape cancels.
 * `required` blocks saving an empty value (used for Name); Territory allows clearing.
 */
function InlineEditCell({ value, onSave, view, placeholder, required = false }: { value: string; onSave: (v: string) => Promise<unknown>; view?: React.ReactNode; placeholder?: string; required?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  const [busy, setBusy] = useState(false);
  const start = () => { setVal(value); setEditing(true); };
  const commit = async () => {
    const trimmed = val.trim();
    if (required && trimmed.length === 0) return; // Name cannot be blank
    if (trimmed === (value ?? "").trim()) { setEditing(false); return; } // no change
    setBusy(true);
    try { await onSave(trimmed); setEditing(false); } finally { setBusy(false); }
  };
  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          autoFocus
          value={val}
          disabled={busy}
          placeholder={placeholder}
          className="h-7 w-40"
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") setEditing(false); }}
        />
        <button onClick={() => void commit()} disabled={busy} className="text-success" title="Save"><Check className="h-4 w-4" /></button>
        <button onClick={() => setEditing(false)} disabled={busy} className="text-muted-foreground" title="Cancel"><X className="h-4 w-4" /></button>
      </span>
    );
  }
  return (
    <span className="group/inline inline-flex items-center gap-1">
      {view ?? (value ? value : <span className="text-muted-foreground">—</span>)}
      <button onClick={start} title="Edit" className="opacity-0 transition-opacity group-hover/inline:opacity-100"><Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>
    </span>
  );
}

function ResetPasswordDialog({ officer, onClose }: { officer: Officer | null; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () => api.post(`/api/users/${officer!.id}/password`, { newPassword: pw }),
    onSuccess: () => { setPw(""); onClose(); },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <Dialog open={!!officer} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reset password — {officer?.name}</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Sets a new password (no old password needed) and signs the officer out of existing sessions.</p>
          <Label>New password</Label>
          <Input type="password" value={pw} onChange={(e) => { setPw(e.target.value); setError(null); }} placeholder="At least 6 characters" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={pw.length < 6 || mut.isPending}>Reset password</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------- Panel: filter + search + the table ------------------ */

/**
 * Reusable panel that owns the status filter + search, fetches from the ONE officers endpoint,
 * and renders `UserTable`. All Users renders it with no group; a Group detail renders it with
 * `groupId` — only the data source (and the Remove-From-Group action) differs.
 */
export function UsersTablePanel({
  groupId,
  headerRight,
  emptyMessage,
  emptyAction,
  includeManagers = false,
  readOnly = false,
}: {
  groupId?: string;
  headerRight?: React.ReactNode;
  emptyMessage?: string;
  emptyAction?: React.ReactNode;
  includeManagers?: boolean; // also list Regional Managers + show role badge/promote/demote
  readOnly?: boolean; // scoped, read-only listing (Regional Manager) — no mutating actions
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<UserFilter>("active");
  const [search, setSearch] = useState("");
  const url = `/api/users/officers?filter=${filter}${groupId ? `&groupId=${groupId}` : ""}${includeManagers ? "&roles=all" : ""}`;
  const { data, isLoading } = useQuery<Officer[]>({
    queryKey: ["officers", filter, groupId ?? "all", includeManagers ? "with-rm" : "so"],
    queryFn: () => api.get<Officer[]>(url),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["officers"] });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data ?? [];
    return (data ?? []).filter((o) => o.name.toLowerCase().includes(q) || o.username.toLowerCase().includes(q));
  }, [data, search]);

  const removeMut = useMutation({
    mutationFn: (officerId: string) => api.del(`/api/groups/${groupId}/members/${officerId}`),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ["groups"] }); qc.invalidateQueries({ queryKey: ["unassigned-officers"] }); },
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            className="w-40"
            options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }, { value: "deleted", label: "Deleted" }, { value: "all", label: "All" }]}
            value={filter}
            onChange={(e) => setFilter(e.target.value as UserFilter)}
          />
          <Input className="w-64" placeholder="Search name or username…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {headerRight}
      </div>
      <UserTable
        users={filtered}
        isLoading={isLoading}
        emptyMessage={emptyMessage}
        emptyAction={emptyAction}
        onRefresh={refresh}
        showGroupColumn={!groupId}
        showRoleActions={includeManagers}
        readOnly={readOnly}
        onRemoveFromGroup={groupId ? (o) => removeMut.mutate(o.id) : undefined}
      />
    </div>
  );
}
