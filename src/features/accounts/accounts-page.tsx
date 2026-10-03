"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableHeader, TableHead, TableRow, TableCell, TableBody } from "@/components/ui/table";
import { ADMIN_MODULES, type AdminModule, type AdminPermissions } from "./permissions";

interface Account { id: string; name: string; username: string; designation: string | null; isActive: boolean; permissions: AdminPermissions }
const ACTION_LABELS: Record<string, string> = { read: "Module access / View", create: "Create", update: "Edit", delete: "Delete / Deactivate", submit: "Submit",
  approve: "Approve / Accept", reject: "Reject", return: "Return for correction", lifecycle: "Lifecycle actions", analyze: "Upload / Analyze", review: "Review", import: "Confirm / Import",
  upload: "Upload", verify: "Verify enrollment", payment: "Record payments", verifyPayment: "Verify payment", post: "Post in Ledger", attendance: "Edit attendance",
  assign: "Assign tag", revoke: "Revoke tag", merge: "Merge / Unmerge", export: "Export", transfer: "Transfer" };
export function AccountsPage() {
  const accounts = useQuery({ queryKey: ["administrative-accounts"], queryFn: () => api.get<Account[]>("/api/accounts") });
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [saved, setSaved] = useState(false);
  return <div className="space-y-5">
    <PageHeader title="Account Management" subtitle="Designations identify accounts. Explicit permissions authorize their actions." actions={<Button onClick={() => { setSaved(false); setEditing("new"); }}><Plus className="mr-2 h-4 w-4" />Create Account</Button>} />
    {saved && <p className="text-sm text-green-600" role="status">Account saved.</p>}
    {accounts.isError && <p className="text-sm text-destructive">{accounts.error.message}</p>}
    <Card><CardContent className="pt-4"><div className="overflow-x-auto"><Table>
      <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Login ID</TableHead><TableHead>Designation</TableHead><TableHead>Status</TableHead><TableHead>Permissions</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>{accounts.data?.map(a => <TableRow key={a.id}><TableCell>{a.name}</TableCell><TableCell>{a.username}</TableCell><TableCell>{a.designation}</TableCell><TableCell>{a.isActive ? "Active" : "Inactive"}</TableCell><TableCell>{Object.keys(a.permissions).length} modules</TableCell><TableCell><Button variant="outline" size="sm" onClick={() => { setSaved(false); setEditing(a); }}>View / Edit</Button></TableCell></TableRow>)}</TableBody>
    </Table>{accounts.isLoading && <p className="p-4 text-sm text-muted-foreground">Loading accounts…</p>}{accounts.data?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No administrative accounts.</p>}</div></CardContent></Card>
    {editing && <AccountDialog account={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setSaved(true); }} />}
  </div>;
}
function AccountDialog({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(account?.name ?? "");
  const [username, setUsername] = useState(account?.username ?? "");
  const [designation, setDesignation] = useState(account?.designation ?? "");
  const [password, setPassword] = useState("");
  const [isActive, setActive] = useState(account?.isActive ?? true);
  const [permissions, setPermissions] = useState<AdminPermissions>(account?.permissions ?? {});
  const save = useMutation({ mutationFn: () => {
    const body = { name, username, designation, isActive, permissions, ...(!account || password ? { password } : {}) };
    return account ? api.patch(`/api/accounts/${account.id}`, body) : api.post("/api/accounts", body);
  }, onSuccess: () => { qc.invalidateQueries({ queryKey: ["administrative-accounts"] }); onSaved(); } });
  const toggle = (module: AdminModule, action: string, checked: boolean) => setPermissions(prev => {
    const next = { ...prev };
    const current = new Set(prev[module] ?? []);
    if (action === "read" && !checked) delete next[module];
    else { if (checked) { current.add("read"); current.add(action); } else current.delete(action); next[module] = [...current]; }
    return next;
  });
  const groups = [...new Set(ADMIN_MODULES.map(m => m.group))];
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
    <DialogHeader><DialogTitle>{account ? "Edit Account" : "Create Account"}</DialogTitle></DialogHeader>
    <form onSubmit={e => { e.preventDefault(); if (account && ((account.isActive && !isActive) || JSON.stringify(account.permissions) !== JSON.stringify(permissions)) && !window.confirm("Save this account's status and permission changes? Removed permissions take effect on subsequent requests.")) return; save.mutate(); }} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="admin-name">Full name *</Label><Input id="admin-name" required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="admin-login">Login ID *</Label><Input id="admin-login" required minLength={3} maxLength={60} value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" /></div>
        <div className="space-y-1"><Label htmlFor="admin-designation">Designation *</Label><Input id="admin-designation" required maxLength={120} value={designation} onChange={e => setDesignation(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="admin-password">{account ? "Reset password (optional)" : "Password *"}</Label><Input id="admin-password" type="password" required={!account} minLength={6} maxLength={200} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="admin-active">Account status *</Label><NativeSelect id="admin-active" value={String(isActive)} onChange={e => setActive(e.target.value === "true")} options={[{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }]} /></div>
      </div>
      <div className="flex items-center justify-between gap-3"><Label>Module and action permissions</Label><div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setPermissions(Object.fromEntries(ADMIN_MODULES.map(m => [m.id, [...m.actions]])))}>Select All</Button><Button type="button" variant="outline" size="sm" onClick={() => setPermissions({})}>Clear All</Button></div></div>
      <p className="text-xs text-muted-foreground">Account Management is owner-only and cannot be delegated. Daily Work is an administrative viewer; employee-only task, plan and rating operations keep their existing restrictions.</p>
      {groups.map(group => <fieldset key={group} className="rounded-md border p-3"><legend className="px-1 text-sm font-semibold">{group}</legend><div className="space-y-2">{ADMIN_MODULES.filter(m => m.group === group).map(m => <details key={m.id} className="rounded border p-2">
        <summary className="cursor-pointer text-sm"><label onClick={e => e.stopPropagation()} className="mr-2 inline-flex items-center gap-2"><input type="checkbox" checked={!!permissions[m.id]?.includes("read")} onChange={e => toggle(m.id, "read", e.target.checked)} />{m.label}</label></summary>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 pl-5">{m.actions.filter(a => a !== "read").map(a => <label key={a} className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={!!permissions[m.id]?.includes(a)} disabled={!permissions[m.id]?.includes("read")} onChange={e => toggle(m.id, a, e.target.checked)} />{ACTION_LABELS[a] ?? a}</label>)}{m.actions.length === 1 && <span className="text-xs text-muted-foreground">View only</span>}</div>
      </details>)}</div></fieldset>)}
      {save.isError && <p className="text-sm text-destructive" role="alert">{save.error.message}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button><Button type="submit" disabled={save.isPending || !name.trim() || !username.trim() || !designation.trim() || (!account && password.length < 6)}>{save.isPending ? "Saving…" : "Save Account"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
