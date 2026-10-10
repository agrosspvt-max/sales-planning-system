"use client";
import { isAdministrativeRole } from "@/features/accounts/permissions";


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
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { L, useLabel } from "@/features/labels/label-ui";
import { type LabelKey } from "@/features/labels/labels";
import { PLAN_STAGES, type PlanStage } from "@/lib/monthly-plan";
import { fill, useLabels } from "./party-labels";

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
const fmtDate = (s: string | null) => (s ? formatSchemeDate(s) : "—");

/* --------------------------- Module Create Plan | View toggle --------------------------- */

// "create" is the legacy appointment-planning page (/planning/party): it is no longer a navigation item, so no primary item is active there.
type PartyMode = "seasonal" | "monthly" | "create" | "view";

// PRIMARY navigation. "Planning" opens the Seasonal tab (/planning/party/seasonal) and stays active for both of its tabs.
const PRIMARY_LINKS: { key: "planning" | "view"; href: string; labelKey: LabelKey }[] = [
  { key: "planning", href: "/planning/party/seasonal", labelKey: "party_planning.nav.planning" },
  { key: "view", href: "/planning/party/view", labelKey: "party_planning.nav.view" },
];
// SECONDARY navigation inside Planning (route-based, so a refresh or Back/Forward keeps the section).
const STAGE_LABEL_KEY: Record<PlanStage, LabelKey> = { create: "party_planning.stage.create", submitted: "party_planning.stage.submitted", approved: "party_planning.stage.approved", older: "party_planning.stage.older" };
const PLANNING_TABS: { key: "seasonal" | "monthly"; href: string; labelKey: LabelKey }[] = [
  { key: "seasonal", href: "/planning/party/seasonal", labelKey: "party_planning.nav.seasonal_tab" },
  { key: "monthly", href: "/planning/party/monthly", labelKey: "party_planning.nav.monthly_tab" },
];

/**
 * Party Planning navigation: [Planning | View]. Under Planning, the Sales Planning-style underline tabs [Seasonal | Monthly] are shown.
 * Territory Mapping is a standalone Create/View Plans module (/planning/territory-mapping) and no longer part of this navigation.
 */
export function PartyPlanModeLinks({ mode, stage = "create", actions, children }: { mode: PartyMode; stage?: PlanStage; actions?: React.ReactNode; children?: React.ReactNode }) {
  const primary = mode === "seasonal" || mode === "monthly" ? "planning" : mode;
  const planLifecycleAria = useLabel("party_planning.nav.plan_lifecycle_aria");
  return (
    <div className="space-y-3">
      {/* Row 1 — main navigation. Each switch sits in its own block row (as Sales Planning does) so they never share a line. */}
      <div className="flex flex-wrap items-center gap-3"><div className="inline-flex flex-wrap rounded-md border bg-background p-0.5 text-sm">
        {PRIMARY_LINKS.map((m) => (
          <Link
            key={m.key}
            href={m.href}
            className={`rounded px-3 py-1.5 font-medium ${primary === m.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <L k={m.labelKey} />
          </Link>
        ))}
      </div></div>
      {primary === "planning" && (
        <>
          {/* Plan lifecycle — route state (?stage=), so the section survives refresh and Back / Forward. Same boxed segmented style as the primary switch. */}
          {/* Row 2 — the labelled "Plan Type" container (same markup as Sales Planning → View Plans) holding the lifecycle switch; Row 3 — Seasonal | Monthly. */}
          <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"><L k="party_planning.nav.plan_type" /></div>
          <div className="flex flex-wrap items-center gap-3"><div className="inline-flex flex-wrap rounded-md border bg-background p-0.5 text-sm" aria-label={planLifecycleAria}>
            {PLAN_STAGES.map((s) => (
              <Link key={s} href={`/planning/party/${mode}?stage=${s}`} aria-current={stage === s ? "page" : undefined}
                className={`rounded px-3 py-1.5 font-medium ${stage === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}><L k={STAGE_LABEL_KEY[s]} /></Link>
            ))}
          </div></div>
          </div>
          {/* Row 3 — Seasonal | Monthly on the left; an optional page action (e.g. Create Seasonal Plan) at the far right of the SAME row (wraps below on small screens). */}
          <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 [&>div:first-child]:min-w-0 [&>div:first-child]:flex-1">
            <UnderlineTabs active={mode} tabs={PLANNING_TABS.map((t) => ({ key: t.key, href: `${t.href}?stage=${stage}`, label: <L k={t.labelKey} /> }))} />
            {actions}
          </div>
        </>
      )}
      {children}
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
  const T = useLabels({ planning: "party_planning.crumb.planning", createView: "party_planning.crumb.create_view", subtitle: "party_planning.legacy.subtitle_create", rejectedBanner: "party_planning.legacy.rejected_banner",
    phParty: "party_planning.legacy.placeholder_party", phMarket: "party_planning.legacy.placeholder_market", rejectedRemark: "party_planning.legacy.rejected_remark", removeRow: "party_planning.legacy.remove_row", saving: "party_planning.common.saving", submitting: "party_planning.common.submitting" });

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: T.planning }, { label: T.createView, href: "/planning/create" }, { label: title }]}
        title={title}
        subtitle={T.subtitle}
      />

      <PartyPlanModeLinks mode="create" />

      {hasRejected && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {T.rejectedBanner}
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
                    <Input value={r.partyName} onChange={(e) => update(i, { partyName: e.target.value })} placeholder={T.phParty} />
                    {r.status === "REJECTED" && r.remarks && <p className="mt-1 text-xs text-destructive">{fill(T.rejectedRemark, { remarks: r.remarks })}</p>}
                  </TableCell>
                  <TableCell><Input value={r.marketName} onChange={(e) => update(i, { marketName: e.target.value })} placeholder={T.phMarket} /></TableCell>
                  <TableCell><Input type="date" value={r.appointmentDate} onChange={(e) => update(i, { appointmentDate: e.target.value })} /></TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => removeRow(i)} disabled={busy} title={T.removeRow}>
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
          <Save className="h-4 w-4" /> {saveMut.isPending ? T.saving : saveLabel}
        </Button>
        <Button onClick={() => { setError(null); submitMut.mutate(); }} disabled={busy || !canSubmit}>
          <Send className="h-4 w-4" /> {submitMut.isPending ? T.submitting : submitLabel}
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
  const isAdmin = isAdministrativeRole(role);
  const [tab, setTab] = useState<"submitted" | "approved">("submitted");
  const title = useLabel("party_planning.title");
  const viewLabel = useLabel("party_planning.nav.view");
  const T = useLabels({ planning: "party_planning.crumb.planning", createView: "party_planning.crumb.create_view", subtitle: "party_planning.legacy.subtitle_view" });

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: T.planning }, { label: T.createView, href: "/planning/create" }, { label: title }, { label: viewLabel }]}
        title={title}
        subtitle={T.subtitle}
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

  const T = useLabels({ empty: "party_planning.legacy.empty", DRAFT: "party_planning.status.draft", PENDING_APPROVAL: "party_planning.status.pending_approval", APPROVED: "party_planning.status.approved", REJECTED: "party_planning.status.rejected" });
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
            <TableRow><TableCell colSpan={cols} className="py-10 text-center text-muted-foreground">{T.empty}</TableCell></TableRow>
          ) : (
            rows!.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.partyName ?? "—"}</TableCell>
                <TableCell>{r.marketName ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap">{fmtDate(r.appointmentDate)}</TableCell>
                <TableCell><Badge variant={STATUS_VARIANT[r.status] ?? "muted"}>{(T as Record<string, string>)[r.status] ?? r.status}</Badge></TableCell>
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
