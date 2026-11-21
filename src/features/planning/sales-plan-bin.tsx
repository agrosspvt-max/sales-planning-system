"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Role } from "@prisma/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Info, MoreVertical, RotateCcw, Trash2 } from "lucide-react";
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { useAdminPermission } from "@/features/accounts/permission-ui";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BinRestoreContext, BinRestoreMode, SalesPlanBinRow } from "./sales-plan-bin.types";

export function SalesPlanBin({ role }: { role: Role }) {
  const qc = useQueryClient();
  const lifecycleGranted = useAdminPermission("salesPlanning", "lifecycle");
  const canRestore = isAdministrativeRole(role) && lifecycleGranted;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [selected, setSelected] = useState<{ row: SalesPlanBinRow; action: "info" | "recover" } | null>(null);
  const [notice, setNotice] = useState("");
  const list = useQuery<SalesPlanBinRow[]>({
    queryKey: ["sales-plan-bin"], queryFn: () => api.get("/api/planning/lifecycle/bin"), enabled: open,
  });
  const rows = useMemo(() => (list.data ?? []).filter(row => (!type || row.planType === type) && `${row.officerName} ${row.seasonName} ${row.monthName ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())), [list.data, search, type]);
  const target = selected?.action === "recover" ? selected.row : null;
  const context = useQuery<BinRestoreContext>({
    queryKey: ["sales-plan-bin-restore", target?.kind, target?.id],
    queryFn: () => api.get(`/api/planning/lifecycle/bin/restore?kind=${target!.kind}&id=${encodeURIComponent(target!.id)}`),
    enabled: !!target && canRestore, staleTime: 0,
  });
  const recover = useMutation({
    mutationFn: (mode: BinRestoreMode) => api.post("/api/planning/lifecycle/bin/restore", { kind: target!.kind, id: target!.id, mode, expectedActiveIds: context.data?.activeVersions.map(p => p.id) ?? [] }),
    onSuccess: async () => {
      setNotice("Plan recovered. All saved planning and sales values were preserved.");
      setSelected(null);
      await Promise.all(["sales-plan-bin", "sales-plan-bin-restore", "plans", "monthly-plans", "officer-plans", "recovery-plans"].map(key => qc.invalidateQueries({ queryKey: [key] })));
    },
  });
  function select(row: SalesPlanBinRow, action: "info" | "recover") {
    recover.reset();
    setSelected({ row, action });
  }
  const conflicts = context.data?.activeVersions ?? [];
  return <>
    <Button variant="outline" title="Deactivated plans" onClick={() => { setNotice(""); setOpen(true); }}><Trash2 className="h-4 w-4" /> Bin</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Deactivated Plans</DialogTitle>
          <DialogDescription>Saved plans are kept here, including monthly plans deactivated with an older seasonal version. Closed seasons and months remain hidden until reopened in Seasons.</DialogDescription>
        </DialogHeader>
        {notice && <p role="status" className="text-sm text-green-600">{notice}</p>}
        <div className="flex flex-wrap gap-3">
          <Input className="max-w-sm" aria-label="Search deactivated plans" placeholder="Search officer, season or month…" value={search} onChange={e => setSearch(e.target.value)} />
          <NativeSelect className="w-44" aria-label="Plan type" value={type} onChange={e => setType(e.target.value)} options={[{ value: "", label: "All plan types" }, ...["Seasonal", "Monthly", "Yearly"].map(value => ({ value, label: value }))]} />
        </div>
        {list.isPending ? <p>Loading deactivated plans…</p> : list.isError ? <div role="alert"><p>{list.error.message}</p><Button variant="outline" onClick={() => list.refetch()}>Try again</Button></div> : <>
          <p className="text-sm text-muted-foreground">{rows.length} deactivated plan{rows.length === 1 ? "" : "s"}</p>
          <Table>
            <TableHeader><TableRow><TableHead>Plan</TableHead><TableHead>Sales Officer</TableHead><TableHead>Version</TableHead><TableHead>Deactivated</TableHead><TableHead>Reason</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map(row => <TableRow key={`${row.kind}:${row.id}`}>
                <TableCell><div className="font-medium">{row.seasonName}{row.monthName ? ` · ${row.monthName}` : ""}</div><div className="text-xs text-muted-foreground">{row.planType}</div></TableCell>
                <TableCell>{row.officerName}</TableCell><TableCell>v{row.version}</TableCell><TableCell>{row.deactivatedAt ? formatDate(row.deactivatedAt) : "Not recorded"}</TableCell>
                <TableCell className="min-w-56 max-w-sm text-sm">{row.reason}</TableCell>
                <TableCell>
                  <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`Actions for ${row.officerName}, ${row.seasonName}${row.monthName ? `, ${row.monthName}` : ""}, ${row.planType} v${row.version}`}><MoreVertical className="h-4 w-4" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem asChild><Link href={row.openHref}><Eye className="h-4 w-4" /> View Plan</Link></DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => select(row, "info")}><Info className="h-4 w-4" /> View Info</DropdownMenuItem>
                      {canRestore && <DropdownMenuItem onSelect={() => select(row, "recover")}><RotateCcw className="h-4 w-4" /> Recover Plan</DropdownMenuItem>}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>)}
              {!rows.length && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">{list.data?.length ? "No plans match these filters." : "The bin is empty."}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </>}
      </DialogContent>
    </Dialog>
    <Dialog open={!!selected} onOpenChange={value => { if (!value && !recover.isPending) setSelected(null); }}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader><DialogTitle>{target ? "Recover Plan" : "Deactivation Info"}</DialogTitle><DialogDescription>{selected?.row.officerName} · {selected?.row.seasonName}{selected?.row.monthName ? ` · ${selected.row.monthName}` : ""} · {selected?.row.planType} v{selected?.row.version}</DialogDescription></DialogHeader>
        {selected && <div className="space-y-3 text-sm">
          <p>{selected.row.reason}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">Deactivated by</dt><dd>{selected.row.actor ?? "Not recorded"}</dd>
            <dt className="text-muted-foreground">Date</dt><dd>{selected.row.deactivatedAt ? formatDate(selected.row.deactivatedAt) : "Not recorded"}</dd>
            <dt className="text-muted-foreground">Approval status</dt><dd>{selected.row.status.replaceAll("_", " ")}</dd>
          </dl>
          {selected.row.auditSummary && <p className="rounded border p-3"><span className="font-medium">Recorded action: </span>{selected.row.auditSummary}</p>}
          {selected.row.inherited && selected.row.parentPlanId && <Button asChild size="sm" variant="outline"><Link href={`/planning/${selected.row.parentPlanId}`}>View Parent Seasonal Plan</Link></Button>}
          {target && (context.isPending ? <p>Checking active versions…</p> : context.isError ? <p role="alert" className="text-destructive">{context.error.message}</p> : <div className="space-y-3 rounded border p-3">
            {conflicts.length ? <p>An active seasonal version already exists: {conflicts.map(p => `v${p.version}`).join(", ")}. Full recovery will archive {conflicts.length === 1 ? "that version" : "those versions"} and its following monthly and recovery plans, then restore v{context.data?.parentVersion}.</p> : <p>This will restore {context.data?.needsParent ? `seasonal v${context.data.parentVersion} and its following monthly and recovery plans` : "this monthly plan"}.</p>}
            {target.kind === "MONTHLY" && <p>You can instead recover only this month as read-only history. Current active plans will stay as they are.</p>}
            <p>All saved values are preserved. Other plans that were closed or deactivated separately keep their own state.</p>
          </div>)}
          {recover.isError && <p role="alert" className="text-destructive">{recover.error.message}</p>}
        </div>}
        <DialogFooter>
          <Button variant="ghost" disabled={recover.isPending} onClick={() => setSelected(null)}>Close</Button>
          {target && context.data && !context.isFetching && !context.isError && <>
            {target.kind === "MONTHLY" && <Button variant="outline" disabled={recover.isPending} onClick={() => recover.mutate("HISTORICAL")}>Recover as History</Button>}
            <Button disabled={recover.isPending} onClick={() => recover.mutate(conflicts.length ? "REPLACE_ACTIVE" : "RESTORE")}>{recover.isPending ? "Recovering…" : conflicts.length ? "Archive Active & Recover" : "Recover Plan"}</Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
