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
import { useLabel } from "@/features/labels/label-ui";
import { ADMIN_MODULES, type AdminModule, type AdminPermissions } from "./permissions";

interface Account { id: string; name: string; username: string; designation: string | null; isActive: boolean; permissions: AdminPermissions }
/** The permission action names shown beside each checkbox (the action ids themselves — read / create / approve … — are fixed identifiers and never change with the wording). */
function useAccountText() {
  const action: Record<string, string> = {
    read: useLabel("accounts.permission.read"),
    create: useLabel("accounts.permission.create"),
    update: useLabel("accounts.permission.update"),
    delete: useLabel("accounts.permission.delete"),
    submit: useLabel("accounts.permission.submit"),
    approve: useLabel("accounts.permission.approve"),
    reject: useLabel("accounts.permission.reject"),
    return: useLabel("accounts.permission.return"),
    lifecycle: useLabel("accounts.permission.lifecycle"),
    analyze: useLabel("accounts.permission.analyze"),
    review: useLabel("accounts.permission.review"),
    import: useLabel("accounts.permission.import"),
    upload: useLabel("accounts.permission.upload"),
    verify: useLabel("accounts.permission.verify"),
    payment: useLabel("accounts.permission.payment"),
    verifyPayment: useLabel("accounts.permission.verifyPayment"),
    post: useLabel("accounts.permission.post"),
    lateReports: useLabel("accounts.permission.lateReports"),
    assign: useLabel("accounts.permission.assign"),
    revoke: useLabel("accounts.permission.revoke"),
    merge: useLabel("accounts.permission.merge"),
    export: useLabel("accounts.permission.export"),
    transfer: useLabel("accounts.permission.transfer"),
  };
  return {
    action,
    title: useLabel("accounts.page.title"), subtitle: useLabel("accounts.page.subtitle"), create: useLabel("accounts.page.create"), saved: useLabel("accounts.page.saved"),
    name: useLabel("accounts.col.name"), login: useLabel("accounts.col.login"), designation: useLabel("accounts.col.designation"), status: useLabel("accounts.col.status"), permissions: useLabel("accounts.col.permissions"),
    active: useLabel("accounts.status.active"), inactive: useLabel("accounts.status.inactive"), modules: useLabel("accounts.msg.modules"), viewEdit: useLabel("accounts.action.view_edit"),
    loading: useLabel("accounts.state.loading"), empty: useLabel("accounts.state.empty"), editTitle: useLabel("accounts.dialog.edit_title"), createTitle: useLabel("accounts.dialog.create_title"),
    fFullName: useLabel("accounts.field.full_name"), fLogin: useLabel("accounts.field.login"), fDesignation: useLabel("accounts.field.designation"), fReset: useLabel("accounts.field.reset_password"),
    fPassword: useLabel("accounts.field.password"), fStatus: useLabel("accounts.field.status"), fPermissions: useLabel("accounts.field.permissions"), selectAll: useLabel("accounts.action.select_all"),
    clearAll: useLabel("accounts.action.clear_all"), help: useLabel("accounts.help.permissions"), viewOnly: useLabel("accounts.msg.view_only"), cancel: useLabel("accounts.action.cancel"),
    save: useLabel("accounts.action.save"), saving: useLabel("accounts.action.saving"), confirm: useLabel("accounts.confirm.save_changes"), createBilling: useLabel("accounts.permission.create_billing_exception"),
  };
}
export function AccountsPage() {
  const L = useAccountText();
  const accounts = useQuery({ queryKey: ["administrative-accounts"], queryFn: () => api.get<Account[]>("/api/accounts") });
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [saved, setSaved] = useState(false);
  return <div className="space-y-5">
    <PageHeader title={L.title} subtitle={L.subtitle} actions={<Button onClick={() => { setSaved(false); setEditing("new"); }}><Plus className="mr-2 h-4 w-4" />{L.create}</Button>} />
    {saved && <p className="text-sm text-green-600" role="status">{L.saved}</p>}
    {accounts.isError && <p className="text-sm text-destructive">{accounts.error.message}</p>}
    <Card><CardContent className="pt-4"><div className="overflow-x-auto"><Table numbered>
      <TableHeader><TableRow><TableHead>{L.name}</TableHead><TableHead>{L.login}</TableHead><TableHead>{L.designation}</TableHead><TableHead>{L.status}</TableHead><TableHead>{L.permissions}</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>{accounts.data?.map(a => <TableRow key={a.id}><TableCell>{a.name}</TableCell><TableCell>{a.username}</TableCell><TableCell>{a.designation}</TableCell><TableCell>{a.isActive ? L.active : L.inactive}</TableCell><TableCell>{L.modules.replace("{count}", String(Object.keys(a.permissions).length))}</TableCell><TableCell><Button variant="outline" size="sm" onClick={() => { setSaved(false); setEditing(a); }}>{L.viewEdit}</Button></TableCell></TableRow>)}</TableBody>
    </Table>{accounts.isLoading && <p className="p-4 text-sm text-muted-foreground">{L.loading}</p>}{accounts.data?.length === 0 && <p className="p-4 text-sm text-muted-foreground">{L.empty}</p>}</div></CardContent></Card>
    {editing && <AccountDialog account={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setSaved(true); }} />}
  </div>;
}
function AccountDialog({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: () => void }) {
  const L = useAccountText();
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
    <DialogHeader><DialogTitle>{account ? L.editTitle : L.createTitle}</DialogTitle></DialogHeader>
    <form onSubmit={e => { e.preventDefault(); if (account && ((account.isActive && !isActive) || JSON.stringify(account.permissions) !== JSON.stringify(permissions)) && !window.confirm(L.confirm)) return; save.mutate(); }} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="admin-name">{L.fFullName}</Label><Input id="admin-name" required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="admin-login">{L.fLogin}</Label><Input id="admin-login" required minLength={3} maxLength={60} value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" /></div>
        <div className="space-y-1"><Label htmlFor="admin-designation">{L.fDesignation}</Label><Input id="admin-designation" maxLength={120} value={designation} onChange={e => setDesignation(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="admin-password">{account ? L.fReset : L.fPassword}</Label><Input id="admin-password" type="password" required={!account} minLength={6} maxLength={200} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="admin-active">{L.fStatus}</Label><NativeSelect id="admin-active" value={String(isActive)} onChange={e => setActive(e.target.value === "true")} options={[{ value: "true", label: L.active }, { value: "false", label: L.inactive }]} /></div>
      </div>
      <div className="flex items-center justify-between gap-3"><Label>{L.fPermissions}</Label><div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setPermissions(Object.fromEntries(ADMIN_MODULES.map(m => [m.id, [...m.actions]])))}>{L.selectAll}</Button><Button type="button" variant="outline" size="sm" onClick={() => setPermissions({})}>{L.clearAll}</Button></div></div>
      <p className="text-xs text-muted-foreground">{L.help}</p>
      {groups.map(group => <fieldset key={group} className="rounded-md border p-3"><legend className="px-1 text-sm font-semibold">{group}</legend><div className="space-y-2">{ADMIN_MODULES.filter(m => m.group === group).map(m => <details key={m.id} className="rounded border p-2">
        <summary className="cursor-pointer text-sm"><label onClick={e => e.stopPropagation()} className="mr-2 inline-flex items-center gap-2"><input type="checkbox" checked={!!permissions[m.id]?.includes("read")} onChange={e => toggle(m.id, "read", e.target.checked)} />{m.label}</label></summary>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 pl-5">{m.actions.filter(a => a !== "read").map(a => <label key={a} className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={!!permissions[m.id]?.includes(a)} disabled={!permissions[m.id]?.includes("read")} onChange={e => toggle(m.id, a, e.target.checked)} />{m.id === "lastPaymentReport" && a === "create" ? L.createBilling : L.action[a] ?? a}</label>)}{m.actions.length === 1 && <span className="text-xs text-muted-foreground">{L.viewOnly}</span>}</div>
      </details>)}</div></fieldset>)}
      {save.isError && <p className="text-sm text-destructive" role="alert">{save.error.message}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>{L.cancel}</Button><Button type="submit" disabled={save.isPending || !name.trim() || !username.trim() || (!account && password.length < 6)}>{save.isPending ? L.saving : L.save}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
