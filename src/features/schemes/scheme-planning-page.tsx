"use client";

import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { CornerUpLeft, Send, Eye, ShieldCheck, ChevronRight, ChevronLeft, ChevronDown } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatDate, formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PillNav } from "@/features/planning/plan-list-ui";
import { L, useLabel } from "@/features/labels/label-ui";
import { PlanStateBadge, SchemeStatusBadge, SchemePlanDialog, PLAN_STATUS_LABEL, MarkedValue, conversionDateCell, bookingCell, documentCell, billingDateCell, type SchemePlan } from "./scheme-detail-dialog";
import { schemeTable, verifyTint } from "./scheme-table-theme";
import { SchemeOfficerWorkspace, SchemePlanningView } from "./scheme-officer-workspace";
import { SchemeCreatePlanWorkspace } from "./scheme-create-plan";
import { SchemeOfficerViewPlan, DealerWiseComingSoon, SchemeWiseCollapsibleView } from "./scheme-view-plan";
import { SchemeManagerModeLinks } from "./scheme-follow-up-view";
import { SchemeMasterPage } from "./scheme-master-page";
import { EnrolledSchemesView } from "./scheme-enrolled-view";

const uniq = (xs: (string | null)[]) => [...new Set(xs.filter(Boolean) as string[])];

/** Compact "3 Approved · 1 Pending for RM · 1 Returned" from a group's dealer plans (by planStatus). */
function planSummary(plans: SchemePlan[]): string {
  const counts = new Map<string, number>();
  for (const p of plans) counts.set(p.planStatus, (counts.get(p.planStatus) ?? 0) + 1);
  return [...counts.entries()].map(([s, n]) => `${n} ${PLAN_STATUS_LABEL[s] ?? s}`).join(" · ");
}
/** Compact scheme-status summary "2 Converted · 1 Pending" (by schemeStatus). */
function schemeSummary(plans: SchemePlan[]): string {
  const converted = plans.filter((p) => p.schemeStatus === "CONVERTED").length;
  const declined = plans.filter((p) => p.schemeStatus === "DECLINED").length;
  const pending = plans.length - converted - declined;
  const parts: string[] = [];
  if (converted) parts.push(`${converted} Converted`);
  if (declined) parts.push(`${declined} Declined`);
  if (pending) parts.push(`${pending} Pending`);
  return parts.join(" · ") || "—";
}

/**
 * Scheme Planning entry (/planning/scheme — CREATE PLAN) — role-aware. Sales Officers get the field-sales
 * create flow (Running Schemes → planning page); Super Admin gets Scheme Master, since for an Admin
 * "creating a plan" means authoring the scheme itself; Regional Managers keep their existing review
 * workspace (approve/reject/return their team's plans, plus their own Running Schemes create tab).
 */
export function SchemePlanningPage({ role, userId }: { role: Role; userId: string }) {
  if (role === Role.SALES_OFFICER) return <SchemeOfficerWorkspace />;
  if (role === Role.SUPER_ADMIN) return <SchemeAdminCreatePlan role={role} />;
  return <SchemeManagerCreatePlan role={role} userId={userId} />;
}

/** Team-officers dropdown source (RM's own Sales Officers). Reused by the RM Create Plan / View Plans shells. */
function useTeamOfficers() {
  return useQuery<{ id: string; name: string }[]>({ queryKey: ["scheme-team-officers"], queryFn: () => api.get("/api/schemes/team-officers") });
}

/** The scope pill row shared by the RM Create Plan and View Plans shells. */
function RmScopeBar<T extends string>({ value, onChange, items, officers, officerId, onOfficer, showOfficer }: {
  value: T; onChange: (v: T) => void; items: { value: T; label: string }[];
  officers: { id: string; name: string }[]; officerId: string; onOfficer: (id: string) => void; showOfficer: boolean;
}) {
  return (
    <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scope</div>
      <div className="flex flex-wrap items-center gap-3">
        <PillNav value={value} onChange={onChange} items={items} />
        {showOfficer && (
          <NativeSelect className="w-56" placeholder="Select a Sales Officer…" value={officerId} onChange={(e) => onOfficer(e.target.value)} options={officers.map((o) => ({ value: o.id, label: o.name }))} />
        )}
      </div>
      {showOfficer && officers.length === 0 && <p className="text-xs text-muted-foreground">No Sales Officers on your team yet.</p>}
    </div>
  );
}

/**
 * Regional Manager → CREATE PLAN. The Sales-Officer create workflow, plus RM scope:
 *   My Schemes    — the RM plans their own dealers (controlled `SchemeCreatePlanWorkspace`, self).
 *   Team Schemes  — pick a team Sales Officer; the RM plans ON THEIR BEHALF (plan.salesOfficerId = that SO,
 *                   enforced server-side by `resolveTargetOfficer`).
 *   All Plan View — every team member as a section, each with the same collapsible create table.
 * Review stays on View Plans (a separate flip), so this route is purely the planning surface.
 */
function SchemeManagerCreatePlan({ role, userId }: { role: Role; userId: string }) {
  const [scope, setScope] = useState<"self" | "team" | "all">("self");
  const [officerId, setOfficerId] = useState("");
  const { data: officers = [] } = useTeamOfficers();
  const lMy = useLabel("scheme_planning.view.my_schemes");
  const lTeam = useLabel("scheme_planning.view.team_schemes");
  const lAllView = useLabel("scheme_planning.view.all_plan_view");
  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Scheme Planning" }, { label: "Create Plan" }]}
        title="Scheme Planning"
        subtitle="Plan your own dealers, or plan on behalf of a Sales Officer on your team."
      />
      <SchemeManagerModeLinks active="planning" role={role} />
      <RmScopeBar
        value={scope}
        onChange={(v) => { setScope(v); setOfficerId(""); }}
        items={[{ value: "self", label: lMy }, { value: "team", label: lTeam }, { value: "all", label: lAllView }]}
        officers={officers}
        officerId={officerId}
        onOfficer={setOfficerId}
        showOfficer={scope === "team"}
      />
      {scope === "all" ? (
        <SchemeAllPlanView userId={userId} officers={officers} />
      ) : scope === "team" ? (
        officerId
          ? <SchemeCreatePlanWorkspace key={officerId} enableRmScope hideScopeSelector controlledOfficerId={officerId} userId={userId} />
          : <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">Select a Sales Officer to plan on their behalf.</div>
      ) : (
        <SchemeCreatePlanWorkspace key="self" enableRmScope hideScopeSelector controlledOfficerId={userId} userId={userId} />
      )}
    </div>
  );
}

/** All Plan View — the RM's whole team, one section per Sales Officer (own first), each reusing the exact
 *  collapsible create table so the RM can plan on behalf of any member from a single screen. */
function SchemeAllPlanView({ userId, officers }: { userId: string; officers: { id: string; name: string }[] }) {
  const sections = [{ id: userId, name: "My Schemes (you)" }, ...officers];
  return (
    <div className="space-y-6">
      {sections.map((o) => (
        <div key={o.id} className="space-y-2">
          <div className="text-sm font-semibold">{o.name}</div>
          <SchemeCreatePlanWorkspace key={o.id} enableRmScope hideScopeSelector controlledOfficerId={o.id} userId={userId} />
        </div>
      ))}
    </div>
  );
}

/**
 * Regional Manager → VIEW PLANS. My Schemes / Team Schemes narrow to one officer (server-validated); All
 * Plans is the team-wide, Sales-Officer-attributed view; Review flips to the existing (unchanged) review
 * workspace, embedded so the outer chrome isn't duplicated.
 */
function SchemeManagerViewPlans({ role, userId }: { role: Role; userId: string }) {
  const [scope, setScope] = useState<"self" | "team" | "all" | "review">("self");
  const [officerId, setOfficerId] = useState("");
  const [tab, setTab] = useState<"scheme" | "enrolled">("scheme");
  const [planningId, setPlanningId] = useState<string | null>(null); // "Continue Planning" (My Schemes only)
  const { data: officers = [] } = useTeamOfficers();
  // Labels resolved unconditionally (before any early return) so hook order is stable.
  const lMy = useLabel("scheme_planning.view.my_schemes");
  const lTeam = useLabel("scheme_planning.view.team_schemes");
  const lAll = useLabel("scheme_planning.view.all_plans");
  const lReview = useLabel("scheme_planning.view.review");
  const lSchemeWise = useLabel("scheme_planning.view.scheme_wise");
  const lEnrolled = useLabel("scheme_planning.view.enrolled_scheme");

  if (planningId) return <SchemePlanningView schemeId={planningId} onBack={() => setPlanningId(null)} />;

  const effOfficer = scope === "self" ? userId : scope === "team" ? officerId : undefined;
  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Scheme Planning" }, { label: "View Plan" }]}
        title="Scheme Planning"
        subtitle="View your plans and your team's, or switch to Review to act on pending plans."
      />
      <SchemeManagerModeLinks active="view" role={role} />
      <RmScopeBar
        value={scope}
        onChange={(v) => { setScope(v); setOfficerId(""); }}
        items={[{ value: "self", label: lMy }, { value: "team", label: lTeam }, { value: "all", label: lAll }, { value: "review", label: lReview }]}
        officers={officers}
        officerId={officerId}
        onOfficer={setOfficerId}
        showOfficer={scope === "team"}
      />

      {scope === "review" ? (
        <SchemeReviewWorkspace role={role} userId={userId} embedded />
      ) : scope === "team" && !officerId ? (
        <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">Select a Sales Officer to view their plans.</div>
      ) : (
        <>
          <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">View</div>
            <div className="flex flex-wrap items-center gap-3">
              <PillNav value={tab} onChange={setTab} items={[{ value: "scheme", label: lSchemeWise }, { value: "enrolled", label: lEnrolled }]} />
            </div>
          </div>
          {tab === "enrolled" ? (
            <EnrolledSchemesView officerId={effOfficer} />
          ) : (
            <SchemeWiseCollapsibleView
              onOpen={setPlanningId}
              officerId={scope === "all" ? undefined : effOfficer}
              groupByOfficer={scope === "all"}
              ownUserId={userId}
              showAction={scope === "self"}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Super Admin → Create Plan. This is the EXISTING Scheme Master, reused — not a copy of it. Every scheme
 * behaviour (create, edit, Open/Closed + State filters, close/reopen, scheme period and last booking date,
 * the installment rule builder, the Enrolled Scheme pill) comes from `SchemeMasterPage`, which remains the
 * single source of truth and stays reachable from its own Master Data route. Only the breadcrumb trail and
 * the mode bar are supplied here, so the page reads as part of Scheme Planning. Authorization is unchanged:
 * every mutating scheme endpoint still enforces Super Admin server-side, and Regional Managers never reach
 * this branch.
 *
 * Below it, the same scheme → dealers collapsible structure the field roles now plan with, in READ-ONLY form
 * (`readOnly`): an Admin can see who has been planned into each running scheme and reach Info / View Document
 * / Share, but gets no Add Dealer and no Save Draft / Submit. Admin authority is untouched — reviewing,
 * verifying and acting on plans stay in View Plan, and nothing here makes Admin an SO-scoped planner.
 */
function SchemeAdminCreatePlan({ role }: { role: Role }) {
  // Two inner options: "View All Scheme" (the Scheme Master list, its internal Enrolled pill hidden here)
  // and "Planned Scheme" (the existing read-only Planned Dealers by Scheme section — moved, not redesigned).
  const [adminView, setAdminView] = useState<"schemes" | "planned">("schemes");
  return (
    <div className="space-y-5">
      <SchemeMasterPage
        hideViewToggle
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Scheme Planning" }, { label: "Create Plan" }]}
        nav={
          <div className="space-y-3">
            {/* Top-level module bar — unchanged (Create Plan | View Plan | Follow-up Plans). */}
            <SchemeManagerModeLinks active="planning" role={role} />
            {/* Inner two-option toggle for Admin Create Plan. */}
            <div className="flex gap-2">
              <button type="button" onClick={() => setAdminView("schemes")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", adminView === "schemes" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}><L k="scheme_planning.view.view_all_scheme" /></button>
              <button type="button" onClick={() => setAdminView("planned")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", adminView === "planned" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}><L k="scheme_planning.view.planned_scheme" /></button>
            </div>
          </div>
        }
        hideList={adminView !== "schemes"}
      />
      {adminView === "planned" && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Planned Dealers by Scheme</div>
          <SchemeCreatePlanWorkspace readOnly />
        </div>
      )}
    </div>
  );
}

/**
 * Scheme Planning · VIEW PLAN (/planning/scheme/plans) — role-aware in the same way. Sales Officers get their
 * own View Plan workspace (Scheme-wise / Dealer-wise / Enrolled Scheme); Super Admin gets the same three-way
 * structure over organization-wide data, and Regional Managers get the review workspace exactly as before.
 * Both manager roles render `SchemeReviewWorkspace`; only its chrome differs (see there).
 */
export function SchemeViewPlansPage({ role, userId }: { role: Role; userId: string }) {
  if (role === Role.SALES_OFFICER) return <SchemeOfficerViewPlan />;
  if (role === Role.REGIONAL_MANAGER) return <SchemeManagerViewPlans role={role} userId={userId} />;
  return <SchemeReviewWorkspace role={role} userId={userId} />;
}

interface SchemeGroup { schemeId: string; schemeName: string; plans: SchemePlan[] }
type ReasonPrompt = { title: string; confirmLabel: string; require: boolean; run: (remarks: string) => void };

/**
 * Panels this workspace can show. `review` is the grouped scheme → dealers table; `running` is the RM-only
 * create tab; `enrolled` and `dealer` are the shared Enrolled Scheme view and the Dealer-wise placeholder.
 * The Admin View Plan tabs below are a presentation of the same states — no second state machine.
 */
type ReviewView = "review" | "running" | "enrolled" | "dealer";


/**
 * RM/Admin review — the SAME grouped, collapsible SCHEME → DEALERS structure for both roles. Only the
 * available actions differ by role: RM approves/returns/rejects planning (incl. Return Entire Scheme);
 * Super Admin verifies enrollment documents. Row-level DealerSchemePlan statuses are never changed by the
 * grouping itself; every action reuses the existing endpoints.
 *
 * The CHROME around that table is role-shaped, because the two roles reach it from different places:
 *   Regional Manager — rendered at BOTH /planning/scheme and /planning/scheme/plans, fronted by the
 *     [Scheme Planning | Follow-up Plans] bar and the Review · Running Schemes · Enrolled Scheme pills.
 *     Unchanged.
 *   Super Admin — rendered only at /planning/scheme/plans (Create Plan is Scheme Master), presented as
 *     View Plan: [Create Plan | View Plan | Follow-up Plans] and the [Scheme-wise | Dealer-wise |
 *     Enrolled Scheme] tabs, where Scheme-wise is this very table with every Admin action intact.
 * The data is identical either way and stays server-scoped: `listSchemePlans` applies `getOfficerScope`, so
 * an Admin receives organization-wide plans and an RM their group's — nothing is filtered in the browser.
 */
function SchemeReviewWorkspace({ role, userId, embedded = false }: { role: Role; userId: string; embedded?: boolean }) {
  const qc = useQueryClient();
  const isManager = role === Role.REGIONAL_MANAGER;
  const isAdmin = role === Role.SUPER_ADMIN;

  const { data: rows, isLoading } = useQuery<SchemePlan[]>({ queryKey: ["scheme-plans", "all"], queryFn: () => api.get("/api/scheme-plans") });
  const [detail, setDetail] = useState<SchemePlan | null>(null);
  const [verify, setVerify] = useState<SchemePlan | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // collapsed by default
  const [reason, setReason] = useState<ReasonPrompt | null>(null);
  // RM gets a "Running Schemes" tab to CREATE plans (skips RM approval); Admin has no create.
  const [view, setView] = useState<ReviewView>("review");
  const [verifyCols, setVerifyCols] = useState(true); // horizontal collapse of the 4 verification columns (UI-only, expanded by default)
  // Admin View-Plan tab labels (global label dictionary).
  const adminViewTabs: { value: ReviewView; label: string }[] = [
    { value: "review", label: useLabel("scheme_planning.view.scheme_wise") },
    { value: "dealer", label: useLabel("scheme_planning.view.dealer_wise") },
    { value: "enrolled", label: useLabel("scheme_planning.view.enrolled_scheme") },
  ];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["scheme-plans"] });

  const groups = useMemo<SchemeGroup[]>(() => {
    const map = new Map<string, SchemeGroup>();
    for (const p of rows ?? []) {
      const g = map.get(p.schemeId) ?? { schemeId: p.schemeId, schemeName: p.schemeName, plans: [] };
      g.plans.push(p);
      map.set(p.schemeId, g);
    }
    return [...map.values()].sort((a, b) => a.schemeName.localeCompare(b.schemeName));
  }, [rows]);

  const submit = useMutation({ mutationFn: (id: string) => api.post(`/api/scheme-plans/${id}/submit`, {}), onSuccess: invalidate, onError: (e) => alert((e as Error).message) });
  const act = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject" | "return"; remarks?: string }) => api.post(`/api/scheme-plans/${v.id}/act`, { action: v.action, remarks: v.remarks }),
    onSuccess: invalidate,
    onError: (e) => alert((e as Error).message),
  });
  const adminAct = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject" | "return"; remarks?: string }) => api.post(`/api/scheme-plans/${v.id}/admin-act`, { action: v.action, remarks: v.remarks }),
    onSuccess: invalidate,
    onError: (e) => alert((e as Error).message),
  });
  // Return Entire Scheme — reuse the per-dealer return endpoint for every applicable submitted plan.
  const bulkReturn = useMutation({
    mutationFn: async (v: { ids: string[]; remarks: string }) => {
      for (const id of v.ids) await api.post(`/api/scheme-plans/${id}/act`, { action: "return", remarks: v.remarks });
    },
    onSuccess: invalidate,
    onError: (e) => alert((e as Error).message),
  });

  const toggle = (schemeId: string) => setExpanded((prev) => { const next = new Set(prev); if (next.has(schemeId)) next.delete(schemeId); else next.add(schemeId); return next; });

  // planStatus is the source of truth for every RM/Admin decision (no branching on legacy planningStatus).
  const canSubmit = (r: SchemePlan) => r.salesOfficerId === userId && (r.planStatus === "DRAFT" || r.planStatus === "RETURNED");
  const canRmAct = (r: SchemePlan) => isManager && r.salesOfficerId !== userId && r.planStatus === "PENDING_RM";
  // Admin is final authority: acts on Pending Approval, and may OVERRIDE a plan still Pending for RM.
  const canAdminAct = (r: SchemePlan) => isAdmin && (r.planStatus === "PENDING_APPROVAL" || r.planStatus === "PENDING_RM");
  // Admin verifies an Approved plan (three-column); enrollment follows only when payment + document complete.
  const canVerify = (r: SchemePlan) => isAdmin && r.planStatus === "APPROVED";
  // Dealers an RM may return in bulk for a scheme (plans pending for RM, not the RM's own).
  const rmReturnable = (g: SchemeGroup) => g.plans.filter((p) => isManager && p.salesOfficerId !== userId && p.planStatus === "PENDING_RM");

  const COLS = 7;

  return (
    <div className="space-y-5">
      {/* When `embedded` (the RM View Plans "Review" flip), the outer chrome is supplied by the host, so the
          workspace renders only its own pills + table — the review functionality itself is unchanged. */}
      {!embedded && (
      <PageHeader
        crumbs={
          isAdmin
            ? [{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Scheme Planning" }, { label: "View Plan" }]
            : [{ label: "Planning" }, { label: "Scheme Planning" }]
        }
        title="Scheme Planning"
        subtitle={isManager ? "Approve, reject or return your team's scheme plans." : "Every scheme planned across the organization — verify enrollment documents and enroll dealers."}
        actions={undefined}
      />
      )}

      {/*
        Level 1 — Admin: Create Plan | View Plan | Follow-up Plans (View Plan active, since Create Plan is
        Scheme Master). RM: rendered by the host when embedded; otherwise the standalone bar.
      */}
      {!embedded && <SchemeManagerModeLinks active={isAdmin ? "view" : "planning"} role={role} />}

      {/*
        Level 2 — Admin: the three View Plan tabs, matching the Sales Officer's structure (no List /
        Collapsible toggle — that was deliberately removed). RM: the existing Review · Running Schemes ·
        Enrolled Scheme pills, unchanged.
      */}
      {isAdmin ? (
        <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">View</div>
          <div className="flex flex-wrap items-center gap-3">
            <PillNav value={view} onChange={setView} items={adminViewTabs} />
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button type="button" onClick={() => setView("review")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", view === "review" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}><L k="scheme_planning.view.review" /></button>
          {isManager && <button type="button" onClick={() => setView("running")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", view === "running" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}><L k="scheme_planning.view.running_schemes" /></button>}
          <button type="button" onClick={() => setView("enrolled")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", view === "enrolled" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}><L k="scheme_planning.view.enrolled_scheme" /></button>
        </div>
      )}

      {view === "enrolled" ? <EnrolledSchemesView /> : view === "dealer" ? <DealerWiseComingSoon /> : view === "running" ? (
        /*
          RM create tab — the same collapsible Create Plan workspace the Sales Officer uses, with the RM's
          existing My Dealers / My Team → Sales Officer scope control (`enableRmScope`). The scope itself is
          still resolved server-side by `resolveTargetOfficer`, so an RM can only plan for their own team.
        */
        <SchemeCreatePlanWorkspace enableRmScope userId={userId} />
      ) : (
      <div className={schemeTable.outer}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead><L k="scheme_planning.col.scheme" /></TableHead>
              <TableHead><L k="scheme_planning.col.dealers" /></TableHead>
              <TableHead><L k="scheme_planning.col.sales_officers" /></TableHead>
              <TableHead><L k="scheme_planning.col.state" /></TableHead>
              <TableHead><L k="scheme_planning.col.plan_status" /></TableHead>
              <TableHead><L k="scheme_planning.col.scheme_status" /></TableHead>
              <TableHead className="text-right"><L k="scheme_planning.col.actions" /></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={COLS + 1}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : groups.length === 0 ? (
              <TableRow><TableCell colSpan={COLS + 1} className="py-10 text-center text-muted-foreground">No scheme plans yet.</TableCell></TableRow>
            ) : (
              groups.map((g) => {
                const open = expanded.has(g.schemeId);
                const officers = uniq(g.plans.map((p) => p.salesOfficerName));
                const states = uniq(g.plans.map((p) => p.state));
                const returnable = rmReturnable(g);
                return (
                  <Fragment key={g.schemeId}>
                    <TableRow className={cn("cursor-pointer", schemeTable.parentRow, open && schemeTable.parentRowOpen)} onClick={() => toggle(g.schemeId)}>
                      <TableCell>{open ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                      <TableCell className="font-semibold">{g.schemeName}</TableCell>
                      <TableCell>{g.plans.length} Dealer{g.plans.length === 1 ? "" : "s"}</TableCell>
                      <TableCell className="max-w-[16rem] truncate" title={officers.join(", ")}>{officers.length <= 1 ? officers[0] ?? "—" : `${officers[0]} +${officers.length - 1}`}</TableCell>
                      <TableCell>{states.length ? states.map((s) => <Badge key={s} variant="secondary" className="mr-1">{s}</Badge>) : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{planSummary(g.plans)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{schemeSummary(g.plans)}</TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        {isManager && returnable.length > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={bulkReturn.isPending}
                            onClick={() => setReason({
                              title: `Return entire scheme — ${g.schemeName}`,
                              confirmLabel: `Return ${returnable.length} dealer${returnable.length === 1 ? "" : "s"}`,
                              require: true,
                              run: (remarks) => bulkReturn.mutate({ ids: returnable.map((p) => p.id), remarks }),
                            })}
                          >
                            <CornerUpLeft className="h-4 w-4" /> Return Entire Scheme
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow>
                        <TableCell colSpan={COLS + 1} className={schemeTable.nestedCell}>
                          <div className={schemeTable.nestedInset}>
                            <div className={schemeTable.nestedShell}>
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead><L k="scheme_planning.nested.dealer" /></TableHead>
                                  <TableHead><L k="scheme_planning.nested.sales_officer" /></TableHead>
                                  <TableHead><L k="scheme_planning.nested.state" /></TableHead>
                                  <TableHead><L k="scheme_planning.nested.planned_conversion" /></TableHead>
                                  <TableHead><L k="scheme_planning.nested.plan_status" /></TableHead>
                                  <TableHead><L k="scheme_planning.nested.scheme_status" /></TableHead>
                                  <TableHead className="w-8 border-l p-0 text-center">
                                    <button type="button" title={verifyCols ? "Hide verification details" : "Show verification details"} aria-label={verifyCols ? "Hide verification details" : "Show verification details"} onClick={() => setVerifyCols((v) => !v)} className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                                      {verifyCols ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                    </button>
                                  </TableHead>
                                  {verifyCols && (
                                    <>
                                      <TableHead className={verifyTint.conversion.head}><L k="scheme_planning.nested.conversion_date" /></TableHead>
                                      <TableHead className={verifyTint.booking.head}><L k="scheme_planning.nested.booking_amount" /></TableHead>
                                      <TableHead className={verifyTint.document.head}><L k="scheme_planning.nested.document_status" /></TableHead>
                                      <TableHead className={verifyTint.billing.head}><L k="scheme_planning.nested.billing_date" /></TableHead>
                                    </>
                                  )}
                                  <TableHead className="border-l text-right"><L k="scheme_planning.nested.actions" /></TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {g.plans.map((r) => (
                                  <TableRow key={r.id}>
                                    <TableCell className="font-medium">{r.dealerName}</TableCell>
                                    <TableCell>{r.salesOfficerName}</TableCell>
                                    <TableCell>{r.state ? <Badge variant="secondary">{r.state}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                                    <TableCell>{r.expectedBillingDate ? formatDate(r.expectedBillingDate) : <span className="text-muted-foreground">—</span>}</TableCell>
                                    <TableCell><PlanStateBadge status={r.planStatus} /></TableCell>
                                    <TableCell>{r.planStatus === "APPROVED" ? <SchemeStatusBadge plan={r} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                                    <TableCell className="border-l" />
                                    {verifyCols && (
                                      <>
                                        <TableCell className={cn("whitespace-nowrap", verifyTint.conversion.cell)}><MarkedValue v={conversionDateCell(r)} /></TableCell>
                                        <TableCell className={cn("whitespace-nowrap", verifyTint.booking.cell)}><MarkedValue v={bookingCell(r)} /></TableCell>
                                        <TableCell className={cn("whitespace-nowrap", verifyTint.document.cell)}><MarkedValue v={documentCell(r)} /></TableCell>
                                        <TableCell className={cn("whitespace-nowrap", verifyTint.billing.cell)}><MarkedValue v={billingDateCell(r)} /></TableCell>
                                      </>
                                    )}
                                    <TableCell className="border-l text-right">
                                      <div className="flex items-center justify-end gap-1">
                                        {canSubmit(r) && <Button size="sm" variant="outline" disabled={submit.isPending} onClick={() => submit.mutate(r.id)}><Send className="h-4 w-4" /> Submit</Button>}
                                        {canRmAct(r) && (
                                          <NativeSelect
                                            className="w-28"
                                            value=""
                                            disabled={act.isPending}
                                            onChange={(e) => {
                                              const a = e.target.value;
                                              e.currentTarget.value = "";
                                              if (a === "approve") act.mutate({ id: r.id, action: "approve" });
                                              else if (a === "return") setReason({ title: `Return dealer — ${r.dealerName}`, confirmLabel: "Return dealer", require: true, run: (remarks) => act.mutate({ id: r.id, action: "return", remarks }) });
                                              else if (a === "reject") setReason({ title: `Reject dealer — ${r.dealerName}`, confirmLabel: "Reject dealer", require: true, run: (remarks) => act.mutate({ id: r.id, action: "reject", remarks }) });
                                            }}
                                            options={[{ value: "", label: "Action…" }, { value: "approve", label: "Accept" }, { value: "return", label: "Return" }, { value: "reject", label: "Reject" }]}
                                          />
                                        )}
                                        {canAdminAct(r) && (
                                          <NativeSelect
                                            className="w-32"
                                            value=""
                                            disabled={adminAct.isPending}
                                            onChange={(e) => {
                                              const a = e.target.value;
                                              e.currentTarget.value = "";
                                              if (a === "approve") adminAct.mutate({ id: r.id, action: "approve" });
                                              else if (a === "return") setReason({ title: `Return dealer — ${r.dealerName}`, confirmLabel: "Return dealer", require: true, run: (remarks) => adminAct.mutate({ id: r.id, action: "return", remarks }) });
                                              else if (a === "reject") setReason({ title: `Reject dealer — ${r.dealerName}`, confirmLabel: "Reject dealer", require: true, run: (remarks) => adminAct.mutate({ id: r.id, action: "reject", remarks }) });
                                            }}
                                            options={[{ value: "", label: "Action…" }, { value: "approve", label: "Approved" }, { value: "return", label: "Return" }, { value: "reject", label: "Reject" }]}
                                          />
                                        )}
                                        {canVerify(r) && <Button size="sm" variant="outline" onClick={() => setVerify(r)}><ShieldCheck className="h-4 w-4" /> Verify</Button>}
                                        <Button size="sm" variant="ghost" onClick={() => setDetail(r)}><Eye className="h-4 w-4" /> Info</Button>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      )}

      {detail && <SchemePlanDialog plan={detail} canVerify={false} onClose={() => setDetail(null)} />}
      {verify && <AdminVerifyDialog plan={verify} onClose={() => setVerify(null)} onSaved={() => { setVerify(null); invalidate(); }} />}
      {reason && <ReasonModal prompt={reason} onClose={() => setReason(null)} />}
    </div>
  );
}

/** Shared return/reject reason modal. Reason is mandatory when `prompt.require` is true. */
function ReasonModal({ prompt, onClose }: { prompt: ReasonPrompt; onClose: () => void }) {
  const [remarks, setRemarks] = useState("");
  const invalid = prompt.require && !remarks.trim();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{prompt.title}</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <Label>Reason {prompt.require ? "*" : "(optional)"}</Label>
          <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Explain what needs to be corrected before resubmitting." rows={4} autoFocus />
          <p className="text-xs text-muted-foreground">The Sales Officer will see this reason and can edit and resubmit.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className={cn(prompt.confirmLabel.toLowerCase().includes("reject") && "bg-destructive text-destructive-foreground hover:bg-destructive/90")} disabled={invalid} onClick={() => { prompt.run(remarks.trim()); onClose(); }}>{prompt.confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------- Admin three-column verification --------------------------- */

const toDateInput = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : "");
const SO_BOOKING_LABEL: Record<string, string> = { RECEIVED: "Received", NOT_RECEIVED: "Not Received", PARTIAL: "Partial Received" };
const SO_DOC_LABEL: Record<string, string> = { SIGNED_BUT_NOT_SENT: "Signed but not Sent", SIGNED_AND_SENT: "Signed & Sent", DOC_RECEIVED: "Doc Received" };

function AdminMark({ mark }: { mark: "" | "✓" | "!" | "✕" }) {
  if (!mark) return null;
  return <span className={cn("font-semibold", mark === "✓" ? "text-success" : mark === "✕" ? "text-destructive" : "text-warning")}>{mark}</span>;
}

/**
 * Admin verification (Field / Sales Officer / Admin). Admin fields start BLANK — the SO value is shown for
 * reference in the middle column but never copied in. ✓/!/✕ appear only for values the Admin explicitly
 * selects. One "Update" saves the verification; the backend auto-enrolls when all four conditions hold
 * (conversion date + booking Received + document Received + billing date). Billing date is disabled until
 * booking + document are both Received. Previously-saved Admin values re-populate on reopen.
 */
function AdminVerifyDialog({ plan, onClose, onSaved }: { plan: SchemePlan; onClose: () => void; onSaved: () => void }) {
  const count = plan.numberOfSchemes || 1;
  const multi = count > 1;
  const instNums = Array.from({ length: count }, (_, i) => i + 1);
  // Seed ONLY from prior Admin values (persisted verification); blank on first open. Never from SO values.
  const [convDate, setConvDate] = useState(toDateInput(plan.adminConversionDate));
  const [booking, setBooking] = useState(plan.adminBookingStatus ?? "");
  const [bookingAmount, setBookingAmount] = useState(plan.adminBookingAmount != null ? String(plan.adminBookingAmount) : "");
  const [doc, setDoc] = useState(plan.adminDocumentStatus ?? "");
  const [sameForAll, setSameForAll] = useState(plan.adminBillingSameForAll ?? true);
  const [billDate, setBillDate] = useState(toDateInput(plan.adminBillingDate ?? plan.instances.find((i) => i.instanceNumber === 1)?.adminBillingDate ?? null));
  const [instDates, setInstDates] = useState<Record<number, string>>(() => {
    const m: Record<number, string> = {};
    for (const i of plan.instances) m[i.instanceNumber] = toDateInput(i.adminBillingDate);
    return m;
  });
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState<string | null>(null);

  const docOk = doc === "RECEIVED_SOFT" || doc === "RECEIVED_HARD";
  const billingEnabled = booking === "RECEIVED" && docOk; // billing only once payment + document Received
  const partialNeedsAmount = booking === "PARTIAL" && !(Number(bookingAmount) > 0);
  const coreComplete = !!convDate && !!booking && !!doc && !partialNeedsAmount;
  const perInstance = multi && !sameForAll;
  const billingComplete = billingEnabled && (perInstance ? instNums.every((n) => !!instDates[n]) : !!billDate);
  const eligible = coreComplete && billingComplete; // all conditions incl. every instance → backend enrolls

  // Markers reflect the Admin's CURRENT selection (blank when nothing chosen yet).
  const bookingMark: "" | "✓" | "!" | "✕" = booking === "" ? "" : booking === "RECEIVED" ? "✓" : booking === "PARTIAL" ? "!" : "✕";
  const docMark: "" | "✓" | "!" | "✕" = doc === "" ? "" : doc === "NOT_RECEIVED" ? "✕" : "✓";
  const convMark: "" | "✓" = convDate ? "✓" : "";

  // When booking/document stop qualifying, clear the (now-disabled) billing dates.
  const clearBilling = () => { setBillDate(""); setInstDates({}); };
  const onBooking = (v: string) => { setBooking(v); if (!(v === "RECEIVED" && docOk)) clearBilling(); };
  const onDoc = (v: string) => { const ok = v === "RECEIVED_SOFT" || v === "RECEIVED_HARD"; setDoc(v); if (!(booking === "RECEIVED" && ok)) clearBilling(); };

  const mut = useMutation({
    mutationFn: () => api.post(`/api/scheme-plans/${plan.id}/verify`, {
      adminConversionDate: convDate,
      adminBookingStatus: booking,
      adminBookingAmount: booking === "NOT_RECEIVED" ? null : (bookingAmount ? Number(bookingAmount) : null),
      adminDocumentStatus: doc,
      adminBillingSameForAll: !perInstance,
      adminBillingDate: billingEnabled && !perInstance ? (billDate || null) : null,
      adminBillingDates: billingEnabled && perInstance ? instNums.map((n) => ({ instanceNumber: n, date: instDates[n] || null })) : undefined,
      remarks: remarks.trim() || undefined,
    }),
    onSuccess: onSaved,
    onError: (e) => setError((e as Error).message),
  });

  const soBooking = plan.soBookingStatus ? `${SO_BOOKING_LABEL[plan.soBookingStatus] ?? plan.soBookingStatus}${plan.soBookingAmount != null ? ` · ${formatCurrency(plan.soBookingAmount)}` : ""}` : "—";
  const Cell = ({ children }: { children: React.ReactNode }) => <td className="border-b px-3 py-2 align-top">{children}</td>;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Verify — {plan.schemeName} · {plan.dealerName}</DialogTitle></DialogHeader>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Field</th><th className="px-3 py-2">Sales Officer</th><th className="px-3 py-2">Admin</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <Cell><span className="font-medium">Conversion Date *</span></Cell>
                <Cell>{plan.conversionDate ? formatDate(plan.conversionDate) : "—"}</Cell>
                <Cell><div className="flex items-center gap-2"><Input type="date" className="w-40" value={convDate} onChange={(e) => setConvDate(e.target.value)} /><AdminMark mark={convMark} /></div></Cell>
              </tr>
              <tr>
                <Cell><span className="font-medium">Booking Amount *</span></Cell>
                <Cell>{soBooking}</Cell>
                <Cell>
                  <div className="flex items-center gap-2">
                    <NativeSelect className="w-40" value={booking} onChange={(e) => onBooking(e.target.value)} options={[{ value: "", label: "Choose Booking Status" }, { value: "RECEIVED", label: "Received" }, { value: "NOT_RECEIVED", label: "Not Received" }, { value: "PARTIAL", label: "Partial Received" }]} />
                    {booking && booking !== "NOT_RECEIVED" && <Input type="number" min="0" className="w-28" placeholder="Amount" value={bookingAmount} onChange={(e) => setBookingAmount(e.target.value)} />}
                    <AdminMark mark={bookingMark} />
                  </div>
                </Cell>
              </tr>
              <tr>
                <Cell><span className="font-medium">Document *</span></Cell>
                <Cell>{plan.soDocumentStatus ? SO_DOC_LABEL[plan.soDocumentStatus] ?? plan.soDocumentStatus : "—"}</Cell>
                <Cell>
                  <div className="flex items-center gap-2">
                    <NativeSelect className="w-52" value={doc} onChange={(e) => onDoc(e.target.value)} options={[{ value: "", label: "Choose Document Status" }, { value: "RECEIVED_SOFT", label: "Received Soft Copy" }, { value: "RECEIVED_HARD", label: "Received Hard Copy" }, { value: "NOT_RECEIVED", label: "Not Received" }]} />
                    <AdminMark mark={docMark} />
                  </div>
                </Cell>
              </tr>
              {!multi ? (
                <tr>
                  <Cell><span className="font-medium">Billing Date</span></Cell>
                  <Cell>{plan.billingDate ? formatDate(plan.billingDate) : "—"}</Cell>
                  <Cell><div className="flex items-center gap-2"><Input type="date" className="w-40" value={billDate} disabled={!billingEnabled} onChange={(e) => setBillDate(e.target.value)} /><AdminMark mark={billDate ? "✓" : ""} /></div></Cell>
                </tr>
              ) : (
                <>
                  <tr>
                    <Cell><span className="font-medium">Billing Dates</span></Cell>
                    <Cell>—</Cell>
                    <Cell>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Same for all schemes?</span>
                        <NativeSelect className="w-24" value={sameForAll ? "yes" : "no"} disabled={!billingEnabled} onChange={(e) => setSameForAll(e.target.value === "yes")} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
                      </div>
                    </Cell>
                  </tr>
                  {sameForAll ? (
                    <tr>
                      <Cell><span className="pl-3 text-muted-foreground">All schemes</span></Cell>
                      <Cell>—</Cell>
                      <Cell><div className="flex items-center gap-2"><Input type="date" className="w-40" value={billDate} disabled={!billingEnabled} onChange={(e) => setBillDate(e.target.value)} /><AdminMark mark={billDate ? "✓" : ""} /></div></Cell>
                    </tr>
                  ) : (
                    instNums.map((n) => {
                      const so = plan.instances.find((i) => i.instanceNumber === n)?.soBillingDate ?? null;
                      return (
                        <tr key={n}>
                          <Cell><span className="pl-3 text-muted-foreground">Scheme {n}</span></Cell>
                          <Cell>{so ? formatDate(so) : "—"}</Cell>
                          <Cell><div className="flex items-center gap-2"><Input type="date" className="w-40" value={instDates[n] ?? ""} disabled={!billingEnabled} onChange={(e) => setInstDates((p) => ({ ...p, [n]: e.target.value }))} /><AdminMark mark={instDates[n] ? "✓" : ""} /></div></Cell>
                        </tr>
                      );
                    })
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
        <div className="space-y-1.5">
          <Label>Remarks</Label>
          <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} placeholder="Optional" />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">
          {!coreComplete
            ? "Select Conversion Date, Booking Amount and Document to update the verification."
            : eligible
              ? "All four conditions are met — Update will enroll the dealer."
              : billingEnabled
                ? "Add a Billing Date to enroll, or Update now to save without enrolling."
                : "Booking and Document must both be Received before a Billing Date / enrollment."}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={mut.isPending || !coreComplete} onClick={() => { setError(null); mut.mutate(); }}>{mut.isPending ? "Updating…" : "Update"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

