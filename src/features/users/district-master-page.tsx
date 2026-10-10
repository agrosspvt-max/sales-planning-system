"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Loader2, Upload } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";

interface District { id: string; name: string; isActive: boolean; aliases: string[] }
interface Payload { groupId: string; groupName: string; districts: District[] }
interface PlanRow { rowNumber: number; name: string; status: "NEW" | "EXISTS" | "INVALID"; reason?: string }
interface Preview { groupName: string; sheet: string | null; error: string | null; plan: PlanRow[]; summary: { total: number; newCount: number; existing: number; invalid: number; inactiveExisting: number } | null }
interface ImportResult { created: number; alreadyThere: number; inactiveExisting: number }

const fill = (t: string, vars: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
async function postFile<T>(url: string, file: File, failed: string): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(url, { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? failed);
  return body as T;
}

/** State Catalogue → Districts: this state's District master (separate from the product catalogue). Upload adds districts; nothing is ever deleted. */
export function DistrictMasterPage({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const L = {
    crumb: useLabel("state_catalogue.districts.crumb"), title: useLabel("state_catalogue.districts.title"), subtitle: useLabel("state_catalogue.districts.subtitle"),
    back: useLabel("state_catalogue.districts.action.back"), download: useLabel("state_catalogue.districts.action.download"), upload: useLabel("state_catalogue.districts.action.upload"),
    activate: useLabel("state_catalogue.districts.action.activate"), deactivate: useLabel("state_catalogue.districts.action.deactivate"),
    colSerial: useLabel("state_catalogue.districts.col.serial"), colName: useLabel("state_catalogue.districts.col.name"), colAliases: useLabel("state_catalogue.districts.col.aliases"),
    colStatus: useLabel("state_catalogue.districts.col.status"), colAction: useLabel("state_catalogue.districts.col.action"),
    active: useLabel("state_catalogue.districts.status.active"), inactive: useLabel("state_catalogue.districts.status.inactive"),
    searchPh: useLabel("state_catalogue.districts.search"), count: useLabel("state_catalogue.districts.count"), empty: useLabel("state_catalogue.districts.empty"),
    pTitle: useLabel("state_catalogue.districts.preview.title"), pNote: useLabel("state_catalogue.districts.preview.note"), pRow: useLabel("state_catalogue.districts.preview.col.row"),
    pName: useLabel("state_catalogue.districts.preview.col.name"), pResult: useLabel("state_catalogue.districts.preview.col.result"),
    sNew: useLabel("state_catalogue.districts.preview.status.new"), sExists: useLabel("state_catalogue.districts.preview.status.exists"), sInvalid: useLabel("state_catalogue.districts.preview.status.invalid"),
    sumNew: useLabel("state_catalogue.districts.preview.sum_new"), sumExisting: useLabel("state_catalogue.districts.preview.sum_existing"), sumInvalid: useLabel("state_catalogue.districts.preview.sum_invalid"),
    inactiveNote: useLabel("state_catalogue.districts.preview.inactive_note"), blocked: useLabel("state_catalogue.districts.preview.blocked"),
    confirm: useLabel("state_catalogue.districts.preview.confirm"), cancel: useLabel("state_catalogue.districts.preview.cancel"), saving: useLabel("state_catalogue.districts.preview.saving"),
    imported: useLabel("state_catalogue.districts.msg.imported"), failed: useLabel("state_catalogue.districts.msg.failed"), updateFailed: useLabel("state_catalogue.districts.msg.update_failed"),
  };

  const { data, isLoading } = useQuery<Payload>({ queryKey: ["state-districts", groupId], queryFn: () => api.get<Payload>(`/api/groups/${groupId}/districts`) });
  const previewMut = useMutation({
    mutationFn: (f: File) => postFile<Preview>(`/api/groups/${groupId}/districts/preview`, f, L.failed),
    onSuccess: (p) => { setPreview(p); setMessage(null); },
    onError: (e) => { setFile(null); setMessage({ ok: false, text: (e as Error).message }); },
  });
  const commitMut = useMutation({
    mutationFn: (f: File) => postFile<ImportResult>(`/api/groups/${groupId}/districts/import`, f, L.failed),
    onSuccess: (r) => { setPreview(null); setFile(null); setMessage({ ok: true, text: fill(L.imported, { created: r.created, existing: r.alreadyThere }) }); qc.invalidateQueries({ queryKey: ["state-districts", groupId] }); qc.invalidateQueries({ queryKey: ["territory-districts"] }); },
    onError: (e) => setMessage({ ok: false, text: (e as Error).message }),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => api.patch(`/api/groups/${groupId}/districts/${v.id}`, { isActive: v.isActive }),
    onSuccess: () => { setMessage(null); qc.invalidateQueries({ queryKey: ["state-districts", groupId] }); qc.invalidateQueries({ queryKey: ["territory-districts"] }); },
    onError: (e) => setMessage({ ok: false, text: (e as Error).message || L.updateFailed }),
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.districts ?? []).filter((d) => !q || d.name.toLowerCase().includes(q) || d.aliases.some((a) => a.toLowerCase().includes(q)));
  }, [data, search]);
  const stateName = data?.groupName ?? "…";
  const activeCount = (data?.districts ?? []).filter((d) => d.isActive).length;
  const statusText = { NEW: L.sNew, EXISTS: L.sExists, INVALID: L.sInvalid } as const;
  const canConfirm = !!preview && !preview.error && !!preview.summary && preview.summary.invalid === 0 && preview.summary.newCount + preview.summary.existing > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: L.crumb, href: "/masters/product-catalogue" }, { label: stateName }]}
        title={fill(L.title, { state: stateName })}
        subtitle={L.subtitle}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild><Link href={`/groups/${groupId}/catalogue`}><ArrowLeft className="h-4 w-4" /> {L.back}</Link></Button>
            <Button variant="outline" size="sm" asChild>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- file-download endpoint */}
              <a href={`/api/groups/${groupId}/districts?format=xlsx`}><Download className="h-4 w-4" /> {L.download}</a>
            </Button>
            <Button variant="outline" size="sm" asChild disabled={previewMut.isPending}>
              <label className="cursor-pointer">
                {previewMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {L.upload}
                <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); previewMut.mutate(f); } e.currentTarget.value = ""; }} />
              </label>
            </Button>
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Input className="w-64" placeholder={L.searchPh} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={L.searchPh} />
        {data && <span className="text-sm text-muted-foreground">{fill(L.count, { active: activeCount, inactive: data.districts.length - activeCount })}</span>}
        {message && <span role="status" className={`text-sm ${message.ok ? "text-success" : "text-destructive"}`}>{message.text}</span>}
      </div>
      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow>
            <TableHead className="w-20">{L.colSerial}</TableHead><TableHead>{L.colName}</TableHead><TableHead>{L.colAliases}</TableHead><TableHead className="w-28">{L.colStatus}</TableHead><TableHead className="w-32 text-right">{L.colAction}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : rows.length === 0 ? <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">{L.empty}</TableCell></TableRow>
                : rows.map((d, i) => (
                  <TableRow key={d.id}>
                    <TableCell className="tabular-nums text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{d.aliases.join(", ") || "—"}</TableCell>
                    <TableCell><Badge variant={d.isActive ? "success" : "muted"}>{d.isActive ? L.active : L.inactive}</Badge></TableCell>
                    <TableCell className="text-right"><Button size="sm" variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: d.id, isActive: !d.isActive })}>{d.isActive ? L.deactivate : L.activate}</Button></TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      {preview && file && (
        <Dialog open onOpenChange={(o) => { if (!o && !commitMut.isPending) { setPreview(null); setFile(null); } }}>
          <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
            <DialogHeader><DialogTitle>{L.pTitle} — {preview.groupName}</DialogTitle></DialogHeader>
            {preview.error ? <p className="text-sm text-destructive">{preview.error}</p> : preview.summary && (
              <div className="space-y-3">
                <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-3">
                  <span>{L.sumNew}: <b>{preview.summary.newCount}</b></span><span>{L.sumExisting}: <b>{preview.summary.existing}</b></span><span>{L.sumInvalid}: <b>{preview.summary.invalid}</b></span>
                </div>
                <p className="text-xs text-muted-foreground">{L.pNote}</p>
                {preview.summary.inactiveExisting > 0 && <p className="text-xs text-muted-foreground">{fill(L.inactiveNote, { count: preview.summary.inactiveExisting })}</p>}
                {preview.summary.invalid > 0 && <p className="text-sm text-destructive">{L.blocked}</p>}
                <div className="max-h-80 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader><TableRow><TableHead className="w-16">{L.pRow}</TableHead><TableHead>{L.pName}</TableHead><TableHead>{L.pResult}</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {preview.plan.map((r) => (
                        <TableRow key={r.rowNumber}>
                          <TableCell className="tabular-nums">{r.rowNumber}</TableCell><TableCell>{r.name || "—"}</TableCell>
                          <TableCell><Badge variant={r.status === "NEW" ? "success" : r.status === "INVALID" ? "destructive" : "muted"}>{statusText[r.status]}</Badge>{r.reason && <span className="ml-2 text-xs text-destructive">{r.reason}</span>}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
            {message && !message.ok && <p className="text-sm text-destructive">{message.text}</p>}
            <DialogFooter>
              <Button variant="outline" disabled={commitMut.isPending} onClick={() => { setPreview(null); setFile(null); }}>{L.cancel}</Button>
              <Button disabled={!canConfirm || commitMut.isPending} onClick={() => commitMut.mutate(file)}>{commitMut.isPending ? L.saving : L.confirm}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
