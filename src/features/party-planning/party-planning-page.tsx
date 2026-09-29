"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus, Trash2, Save, Send, Check, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatSchemeDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { L, useLabel } from "@/features/labels/label-ui";
import { type LabelKey } from "@/features/labels/labels";

/* --------------------------------- Shared types --------------------------------- */

export interface PartyPlan {
  id: string;
  salesOfficerId: string;
  employeeName: string;
  partyName: string | null;
  marketName: string | null;
  appointmentDate: string | null; // "YYYY-MM-DD"
  status: string;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
}

// Status badge tone (values are DB constants — labels shown as-is, never renamed here).
const STATUS_VARIANT: Record<string, "secondary" | "success" | "destructive" | "muted"> = {
  DRAFT: "muted", PENDING_APPROVAL: "secondary", APPROVED: "success", REJECTED: "destructive",
};
const STATUS_TEXT: Record<string, string> = {
  DRAFT: "Draft", PENDING_APPROVAL: "Pending Approval", APPROVED: "Approved", REJECTED: "Rejected",
};
const fmtDate = (s: string | null) => (s ? formatSchemeDate(s) : "—");

/* --------------------------- Module Create Plan | View toggle --------------------------- */

const MODE_LINKS: { key: "create" | "view"; href: string; labelKey: LabelKey }[] = [
  { key: "create", href: "/planning/party", labelKey: "party_planning.nav.create_plan" },
  { key: "view", href: "/planning/party/view", labelKey: "party_planning.nav.view" },
];

/** Route-based [Create Plan | View] toggle — mirrors the Scheme module's mode links. */
export function PartyPlanModeLinks({ mode }: { mode: "create" | "view" }) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
      {MODE_LINKS.map((m) => (
        <Link
          key={m.key}
          href={m.href}
          className={`rounded px-3 py-1.5 font-medium ${mode === m.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          <L k={m.labelKey} />
        </Link>
      ))}
    </div>
  );
}

/* ==================================== CREATE PLAN ==================================== */

interface EditRow { id?: string; partyName: string; marketName: string; appointmentDate: string; status?: string; remarks?: string | null }
const blankRow = (): EditRow => ({ partyName: "", marketName: "", appointmentDate: "", status: "DRAFT" });

/**
 * Create Plan — an editable multi-row table (Party Name | Market Name | Date of Appointment). It loads the
 * caller's own editable set (Draft + Rejected plans; a rejected plan re-appears here to be corrected and
 * re-submitted), lets rows be added/removed, and persists the whole set atomically via Save Draft or Submit.
 */
export function PartyCreatePlanPage() {
  const qc = useQueryClient();
  const { data: existing, isLoading } = useQuery<PartyPlan[]>({
    queryKey: ["party-plans", "editable"],
    queryFn: () => api.get<PartyPlan[]>("/api/party-plans?view=editable"),
  });

  const [rows, setRows] = useState<EditRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Seed the editor from the server once loaded (one blank row when there is nothing to edit yet).
  useEffect(() => {
    if (!existing) return;
    setRows(
      existing.length > 0
        ? existing.map((p) => ({ id: p.id, partyName: p.partyName ?? "", marketName: p.marketName ?? "", appointmentDate: p.appointmentDate ?? "", status: p.status, remarks: p.remarks }))
        : [blankRow()],
    );
  }, [existing]);

  const hasRejected = useMemo(() => rows.some((r) => r.status === "REJECTED"), [rows]);

  const payload = () => ({ rows: rows.map((r) => ({ id: r.id, partyName: r.partyName, marketName: r.marketName, appointmentDate: r.appointmentDate })) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["party-plans"] });

  const saveMut = useMutation({
    mutationFn: () => api.post("/api/party-plans/save-draft", payload()),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (e) => setError((e as Error).message),
  });
  const submitMut = useMutation({
    mutationFn: () => api.post<{ count: number }>("/api/party-plans/submit", payload()),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (e) => setError((e as Error).message),
  });
  const busy = saveMut.isPending || submitMut.isPending;

  const update = (i: number, patch: Partial<EditRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, blankRow()]);
  const removeRow = (i: number) => setRows((rs) => (rs.length <= 1 ? [blankRow()] : rs.filter((_, j) => j !== i)));

  // Client-side gate (server is authoritative): Submit needs at least one row with all three fields.
  const meaningful = rows.filter((r) => r.partyName.trim().length > 0);
  const canSubmit = meaningful.length > 0 && meaningful.every((r) => r.marketName.trim() && r.appointmentDate);

  // Hooks must be called unconditionally — resolve label text once, up front.
  const title = useLabel("party_planning.title");
  const saveLabel = useLabel("party_planning.action.save_draft");
  const submitLabel = useLabel("party_planning.action.submit");

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: title }]}
        title={title}
        subtitle="Add the parties you plan to meet, then Save Draft or Submit for approval."
      />

      <PartyPlanModeLinks mode="create" />

      {hasRejected && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          One or more plans were rejected. Update them below and submit again. Any admin remark is shown under the row.
        </div>
      )}

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[34%]"><L k="party_planning.col.party_name" /></TableHead>
              <TableHead className="w-[30%]"><L k="party_planning.col.market_name" /></TableHead>
              <TableHead className="w-[26%]"><L k="party_planning.col.appointment_date" /></TableHead>
              <TableHead className="w-[10%] text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (
              rows.map((r, i) => (
                <TableRow key={r.id ?? `new-${i}`}>
                  <TableCell>
                    <Input value={r.partyName} onChange={(e) => update(i, { partyName: e.target.value })} placeholder="Party name" />
                    {r.status === "REJECTED" && r.remarks && <p className="mt-1 text-xs text-destructive">Rejected: {r.remarks}</p>}
                  </TableCell>
                  <TableCell><Input value={r.marketName} onChange={(e) => update(i, { marketName: e.target.value })} placeholder="Market name" /></TableCell>
                  <TableCell><Input type="date" value={r.appointmentDate} onChange={(e) => update(i, { appointmentDate: e.target.value })} /></TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => removeRow(i)} disabled={busy} title="Remove row">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={addRow} disabled={busy}><Plus className="h-4 w-4" /> <L k="party_planning.action.add_row" /></Button>
        <div className="flex-1" />
        <Button variant="outline" onClick={() => { setError(null); saveMut.mutate(); }} disabled={busy}>
          <Save className="h-4 w-4" /> {saveMut.isPending ? "Saving…" : saveLabel}
        </Button>
        <Button onClick={() => { setError(null); submitMut.mutate(); }} disabled={busy || !canSubmit}>
          <Send className="h-4 w-4" /> {submitMut.isPending ? "Submitting…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}

/* ======================================= VIEW ======================================= */

/**
 * View — exactly two tabs. Submitted lists PENDING_APPROVAL plans (Admin gets Approve / Reject actions);
 * Approved lists APPROVED plans read-only. Rejected plans intentionally have no tab here — they return to
 * Create Plan for the owner to correct (the app's Returned/Rejected → editable convention).
 */
export function PartyViewPage({ role }: { role: Role }) {
  const isAdmin = role === Role.SUPER_ADMIN;
  const [tab, setTab] = useState<"submitted" | "approved">("submitted");
  const title = useLabel("party_planning.title");
  const viewLabel = useLabel("party_planning.nav.view");

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: title }, { label: viewLabel }]}
        title={title}
        subtitle="Submitted plans await approval; approved plans are read-only."
      />

      <PartyPlanModeLinks mode="view" />

      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
        {(["submitted", "approved"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 font-medium ${tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <L k={t === "submitted" ? "party_planning.view.submitted" : "party_planning.view.approved"} />
          </button>
        ))}
      </div>

      {tab === "submitted" ? <PartyTable view="submitted" showAction={isAdmin} /> : <PartyTable view="approved" showAction={false} />}
    </div>
  );
}

function PartyTable({ view, showAction }: { view: "submitted" | "approved"; showAction: boolean }) {
  const qc = useQueryClient();
  const { data: rows, isLoading } = useQuery<PartyPlan[]>({
    queryKey: ["party-plans", view],
    queryFn: () => api.get<PartyPlan[]>(`/api/party-plans?view=${view}`),
  });

  const actMut = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject" }) => api.post(`/api/party-plans/${v.id}/act`, { action: v.action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["party-plans"] }),
    onError: (e) => alert((e as Error).message),
  });

  const cols = showAction ? 5 : 4;
  return (
    <div className="overflow-auto rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead><L k="party_planning.col.party_name" /></TableHead>
            <TableHead><L k="party_planning.col.market_name" /></TableHead>
            <TableHead><L k="party_planning.col.appointment_date" /></TableHead>
            <TableHead><L k="party_planning.col.status" /></TableHead>
            {showAction && <TableHead className="text-right"><L k="party_planning.col.action" /></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={cols}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
          ) : (rows?.length ?? 0) === 0 ? (
            <TableRow><TableCell colSpan={cols} className="py-10 text-center text-muted-foreground">No party plans here yet.</TableCell></TableRow>
          ) : (
            rows!.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.partyName ?? "—"}</TableCell>
                <TableCell>{r.marketName ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap">{fmtDate(r.appointmentDate)}</TableCell>
                <TableCell><Badge variant={STATUS_VARIANT[r.status] ?? "muted"}>{STATUS_TEXT[r.status] ?? r.status}</Badge></TableCell>
                {showAction && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" disabled={actMut.isPending} onClick={() => actMut.mutate({ id: r.id, action: "approve" })}>
                        <Check className="h-4 w-4" /> <L k="party_planning.action.approve" />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive" disabled={actMut.isPending} onClick={() => actMut.mutate({ id: r.id, action: "reject" })}>
                        <X className="h-4 w-4" /> <L k="party_planning.action.reject" />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
