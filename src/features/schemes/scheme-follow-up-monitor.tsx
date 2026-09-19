"use client";

/**
 * FOLLOW UP (/planning/scheme/follow-up-monitor) — a NEW monitoring hub, SEPARATE from the existing
 * "Follow-up Plans" recovery page. Top-level tab "Follow Up" with three underlined sub-tabs:
 *   Conversion Follow-up — implemented (below)
 *   Billing Follow-up    — Coming Soon
 *   Payment Follow-up    — Coming Soon
 *
 * The Conversion Follow-up is a READ/monitoring layer built entirely on EXISTING data and components:
 *   • rows come from the same role-scoped `GET /api/scheme-plans?bucket=view` the View Plan uses
 *     (`listSchemePlans` applies `getOfficerScope`, so SO→own, RM→team, Admin→all — visibility unchanged);
 *   • conversion date + extension count + Admin override render through the existing `PlannedConversionCell`;
 *   • Plan Status / Scheme Status reuse `PlanStateBadge` / `SchemeStatusBadge` (identical to View Plan → Approved);
 *   • booking / document reuse `bookingCell` / `documentCell`;
 *   • per-dealer actions reuse the existing `ConversionModal` (SO) and `AdminVerifyDialog` (Admin) and the
 *     existing conversion-extension dialog (`SchemePlanDialog canExtend`). No new data model, no new action logic.
 * Scheme-level figures are aggregated in the browser from the dealer rows of each scheme.
 */

import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Info, ShieldCheck, Pencil } from "lucide-react";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { cn, formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/components/ui/select";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PillNav, UnderlineTabs } from "@/features/planning/plan-list-ui";
import { L, useLabel } from "@/features/labels/label-ui";
import { PlanStateBadge, SchemeStatusBadge, SchemePlanDialog, MarkedValue, documentCell, PlannedConversionCell, type SchemePlan } from "./scheme-detail-dialog";
import { bookingCoverageUnits } from "@/lib/scheme-booking-coverage";
import { schemeTable, verifyTint } from "./scheme-table-theme";
import { ConversionModal } from "./scheme-view-plan";
import { AdminVerifyDialog } from "./scheme-planning-page";
import { SchemePlanModeLinks } from "./scheme-officer-workspace";
import { SchemeManagerModeLinks } from "./scheme-follow-up-view";
import { SchemeSectionComingSoon } from "./scheme-coming-soon";

const num = (v: number | null | undefined) => v ?? 0;
const isConverted = (p: SchemePlan) => p.schemeStatus === "CONVERTED";
const documentReceived = (p: SchemePlan) => p.adminDocumentStatus === "RECEIVED_SOFT" || p.adminDocumentStatus === "RECEIVED_HARD";
/** Number of scheme instances whose Paid booking is verified (Conversion Follow-up "Booking Amt."). */
const bookingUnits = (p: SchemePlan) => bookingCoverageUnits({ adminBookingSchemeCount: p.adminBookingSchemeCount, adminBookingStatus: p.adminBookingStatus, numberOfSchemes: p.numberOfSchemes });

/* --------------------------------- Conversion Follow-up --------------------------------- */

interface SchemeGroup {
  schemeId: string;
  schemeName: string;
  plans: SchemePlan[];
  plannedDealers: number;
  plannedUnits: number;
  planAmountWoGst: number;
  soldUnits: number;
  actualAmountWoGst: number;
  bookingCount: number;
  documentCount: number;
}

/** Conversion Follow-up. `representation` chooses the SAME data's presentation: "scheme" = expandable
 *  scheme-level table over its dealer rows; "dealer" = a flat dealer-level table across all schemes. The
 *  switch is owned by the hub and shared with Billing/Payment. `officerId` narrows to one Sales Officer (RM
 *  "Team" scope); omitted → the caller's own server-scoped set. */
export function SchemeConversionFollowUp({ role, officerId, representation = "scheme" }: { role: Role; officerId?: string; representation?: "scheme" | "dealer" }) {
  const qc = useQueryClient();
  const isAdmin = role === Role.SUPER_ADMIN;
  const isOfficer = role === Role.SALES_OFFICER;
  const scopeKey = officerId ?? (isAdmin ? "all" : "mine");
  const { data, isLoading } = useQuery<SchemePlan[]>({
    queryKey: ["scheme-plans", "view", scopeKey],
    queryFn: () => api.get(`/api/scheme-plans?bucket=view${officerId ? `&officerId=${encodeURIComponent(officerId)}` : ""}`),
  });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [infoPlan, setInfoPlan] = useState<SchemePlan | null>(null);
  const [convert, setConvert] = useState<SchemePlan | null>(null);
  const [verify, setVerify] = useState<SchemePlan | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["scheme-plans"] });

  // Conversion Follow-up tracks APPROVED, still-open plans (the exact set View Plan → Approved shows). Closed
  // schemes belong to Older Plans; submitted/draft have not reached the conversion stage.
  const eligible = useMemo(() => (data ?? []).filter((p) => p.planStatus === "APPROVED" && !p.schemeClosed), [data]);
  const groups = useMemo<SchemeGroup[]>(() => {
    const byScheme = new Map<string, SchemePlan[]>();
    for (const p of eligible) byScheme.set(p.schemeId, [...(byScheme.get(p.schemeId) ?? []), p]);
    return [...byScheme.entries()]
      .map(([schemeId, plans]) => ({
        schemeId,
        schemeName: plans[0].schemeName,
        plans,
        plannedDealers: new Set(plans.map((p) => p.dealerId)).size,
        plannedUnits: plans.reduce((s, p) => s + (p.numberOfSchemes || 1), 0),
        planAmountWoGst: plans.reduce((s, p) => s + num(p.plannedAmountWithoutGST), 0),
        soldUnits: plans.reduce((s, p) => s + (isConverted(p) ? (p.numberOfSchemes || 1) : 0), 0),
        actualAmountWoGst: plans.reduce((s, p) => s + num(p.actualAmountWithoutGST), 0),
        // Booking Amt. = number of scheme instances with a verified Paid booking (Σ coverage), not a dealer count.
        bookingCount: plans.reduce((s, p) => s + bookingUnits(p), 0),
        documentCount: plans.filter(documentReceived).length,
      }))
      .sort((a, b) => a.schemeName.localeCompare(b.schemeName));
  }, [eligible]);

  // Flat dealer list (Dealer-wise) — the SAME rows, ungrouped, ordered by scheme then dealer.
  const flatDealers = useMemo(
    () => [...eligible].sort((a, b) => a.schemeName.localeCompare(b.schemeName) || a.dealerName.localeCompare(b.dealerName)),
    [eligible],
  );

  // One dealer row, reused by the nested (Scheme-wise) and flat (Dealer-wise) tables. `withScheme` prepends a
  // Scheme column so a flat row is identifiable without its parent grouping.
  const dealerRow = (p: SchemePlan, withScheme: boolean) => (
    <TableRow key={p.id}>
      {withScheme && <TableCell className="font-medium">{p.schemeName}</TableCell>}
      <TableCell className="font-medium">
        <div className="flex items-center gap-1.5">
          <span>{p.dealerName}</span>
          <button type="button" title={p.soNote ? "Info · note added" : "Info"} onClick={() => setInfoPlan(p)}>
            <Info className={cn("h-3.5 w-3.5", p.soNote ? "text-success" : "text-muted-foreground")} />
          </button>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{p.numberOfSchemes}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCurrency(num(p.plannedAmountWithoutGST))}</TableCell>
      <TableCell><PlannedConversionCell plan={p} /></TableCell>
      <TableCell><PlanStateBadge status={p.planStatus} /></TableCell>
      <TableCell><SchemeStatusBadge plan={p} /></TableCell>
      {/* Sold Sch. Units — this dealer's converted units (the per-dealer part of the scheme-level soldUnits). */}
      <TableCell className="text-right tabular-nums">{isConverted(p) ? (p.numberOfSchemes || 1) : 0}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCurrency(num(p.actualAmountWithoutGST))}</TableCell>
      {/* Booking Amt. = how many of this dealer's schemes have a verified Paid booking (coverage count). */}
      <TableCell className={cn("text-right tabular-nums", verifyTint.booking.cell)}>{bookingUnits(p)} / {p.numberOfSchemes}</TableCell>
      <TableCell className={cn("whitespace-nowrap", verifyTint.document.cell)}><MarkedValue v={documentCell(p)} /></TableCell>
      <TableCell className="border-l text-right">
        <div className="flex items-center justify-end gap-1">
          {isAdmin && <Button size="sm" variant="outline" onClick={() => setVerify(p)}><ShieldCheck className="h-4 w-4" /> <L k="scheme_planning.action.verify" /></Button>}
          {isOfficer && <Button size="sm" variant="outline" onClick={() => setConvert(p)}><Pencil className="h-4 w-4" /> <L k="scheme_planning.action.update" /></Button>}
          {!isAdmin && !isOfficer && <span className="text-muted-foreground">—</span>}
        </div>
      </TableCell>
    </TableRow>
  );

  // The dealer-table header, reused by both representations (`withScheme` prepends the Scheme column).
  const dealerHead = (withScheme: boolean) => (
    <TableRow>
      {withScheme && <TableHead><L k="scheme_planning.col.scheme" /></TableHead>}
      <TableHead><L k="scheme_planning.follow_up.col.dealer" /></TableHead>
      <TableHead className="text-right"><L k="scheme_planning.follow_up.col.planned_units" /></TableHead>
      <TableHead className="text-right"><L k="scheme_planning.follow_up.col.planned_amount" /></TableHead>
      <TableHead><L k="scheme_planning.follow_up.col.conversion_date" /></TableHead>
      <TableHead><L k="scheme_planning.follow_up.col.plan_status" /></TableHead>
      <TableHead><L k="scheme_planning.follow_up.col.scheme_status" /></TableHead>
      <TableHead className="text-right"><L k="scheme_planning.follow_up.col.sold_units" /></TableHead>
      <TableHead className="text-right"><L k="scheme_planning.follow_up.col.actual_amount_wo_gst" /></TableHead>
      <TableHead className={verifyTint.booking.head}><L k="scheme_planning.follow_up.col.booking_amount" /></TableHead>
      <TableHead className={verifyTint.document.head}><L k="scheme_planning.follow_up.col.document_status" /></TableHead>
      <TableHead className="border-l text-right"><L k="scheme_planning.follow_up.col.action" /></TableHead>
    </TableRow>
  );

  const SCHEME_COLS = 9; // chevron + 8 scheme columns
  const DEALER_COLS = 12; // scheme + 11 dealer columns (incl. Sold Sch. Units)

  const dialogs = (
    <>
      {/* Reused action dialogs — same components/endpoints as View Plan, so no conversion/verification logic is duplicated. */}
      {infoPlan && <SchemePlanDialog plan={infoPlan} canExtend={isOfficer} onExtended={() => { setInfoPlan(null); invalidate(); }} onClose={() => setInfoPlan(null)} />}
      {convert && <ConversionModal plan={convert} salesOfficerView onClose={() => setConvert(null)} onSaved={() => { setConvert(null); invalidate(); }} />}
      {verify && <AdminVerifyDialog plan={verify} onClose={() => setVerify(null)} onSaved={() => { setVerify(null); invalidate(); }} />}
    </>
  );

  if (representation === "dealer") {
    return (
      <div className={schemeTable.outer}>
        <Table>
          <TableHeader>{dealerHead(true)}</TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={DEALER_COLS}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : flatDealers.length === 0 ? (
              <TableRow><TableCell colSpan={DEALER_COLS} className="py-10 text-center text-muted-foreground"><L k="scheme_planning.follow_up.empty" /></TableCell></TableRow>
            ) : (
              flatDealers.map((p) => dealerRow(p, true))
            )}
          </TableBody>
        </Table>
        {dialogs}
      </div>
    );
  }

  return (
    <div className={schemeTable.outer}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead><L k="scheme_planning.col.scheme" /></TableHead>
            <TableHead className="text-right"><L k="scheme_planning.follow_up.col.planned_dealers" /></TableHead>
            <TableHead className="text-right"><L k="scheme_planning.follow_up.col.planned_units" /></TableHead>
            <TableHead className="text-right"><L k="scheme_planning.follow_up.col.plan_amount_wo_gst" /></TableHead>
            <TableHead className="text-right"><L k="scheme_planning.follow_up.col.sold_units" /></TableHead>
            <TableHead className="text-right"><L k="scheme_planning.follow_up.col.actual_amount_wo_gst" /></TableHead>
            <TableHead className="text-right"><L k="scheme_planning.follow_up.col.booking_amount" /></TableHead>
            <TableHead className="text-right"><L k="scheme_planning.follow_up.col.document_status" /></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={SCHEME_COLS}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
          ) : groups.length === 0 ? (
            <TableRow><TableCell colSpan={SCHEME_COLS} className="py-10 text-center text-muted-foreground"><L k="scheme_planning.follow_up.empty" /></TableCell></TableRow>
          ) : (
            groups.map((g) => {
              const open = expanded.has(g.schemeId);
              return (
                <Fragment key={g.schemeId}>
                  <TableRow className={cn("cursor-pointer", schemeTable.parentRow, open && schemeTable.parentRowOpen)} onClick={() => toggle(g.schemeId)}>
                    <TableCell>{open ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                    <TableCell className="font-semibold">{g.schemeName}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.plannedDealers}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.plannedUnits}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(g.planAmountWoGst)}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.soldUnits}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(g.actualAmountWoGst)}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.bookingCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.documentCount}</TableCell>
                  </TableRow>
                  {open && (
                    <TableRow>
                      <TableCell colSpan={SCHEME_COLS} className={schemeTable.nestedCell}>
                        <div className={schemeTable.nestedInset}>
                          <div className={schemeTable.nestedShell}>
                            <Table>
                              <TableHeader>{dealerHead(false)}</TableHeader>
                              <TableBody>
                                {g.plans.map((p) => dealerRow(p, false))}
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
      {dialogs}
    </div>
  );
}

/* --------------------------------- Follow Up hub page --------------------------------- */

type FollowUpTab = "conversion" | "billing" | "payment";

/** Follow Up hub — nav (monitor active) + underlined sub-tabs. RM gets the same My/Team scope selector the
 *  existing Follow-up Plans page uses; SO/Admin are server-scoped. */
export function SchemeFollowUpMonitorPage({ role }: { role: Role }) {
  const isOfficer = role === Role.SALES_OFFICER;
  const isManager = role === Role.REGIONAL_MANAGER;
  const [tab, setTab] = useState<FollowUpTab>("conversion");
  // ONE shared Scheme-wise / Dealer-wise switch that applies to whichever Follow-up Type (VIEW) is selected.
  const [rep, setRep] = useState<"scheme" | "dealer">("scheme");
  const [scope, setScope] = useState<"self" | "team">("self");
  const [officerId, setOfficerId] = useState("");
  const conversionLbl = useLabel("scheme_planning.follow_up.conversion");
  const billingLbl = useLabel("scheme_planning.follow_up.billing");
  const paymentLbl = useLabel("scheme_planning.follow_up.payment");
  const schemeWiseLbl = useLabel("scheme_planning.follow_up.scheme_wise");
  const dealerWiseLbl = useLabel("scheme_planning.follow_up.dealer_wise");
  const titleLbl = useLabel("scheme_planning.follow_up.title");
  const subtitleLbl = useLabel("scheme_planning.follow_up.subtitle");
  const comingSoonLbl = useLabel("scheme_planning.state.coming_soon");
  const selectOfficerLbl = useLabel("scheme_planning.follow_up.select_officer");
  const myLbl = useLabel("scheme_planning.view.my_schemes");
  const teamLbl = useLabel("scheme_planning.view.team_schemes");
  const { data: officers = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["scheme-team-officers"], queryFn: () => api.get("/api/schemes/team-officers"), enabled: isManager,
  });
  const effOfficer = isManager ? (scope === "team" ? officerId : undefined) : undefined;

  const tabs: { value: FollowUpTab; label: string }[] = [
    { value: "conversion", label: conversionLbl },
    { value: "billing", label: billingLbl },
    { value: "payment", label: paymentLbl },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={
          isOfficer
            ? [{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Scheme Planning" }, { label: "Follow Up" }]
            : [{ label: "Planning" }, { label: "Scheme Planning", href: "/planning/scheme" }, { label: "Follow Up" }]
        }
        title={titleLbl}
        subtitle={subtitleLbl}
      />

      {/* Level 1 — the shared module bar with the new "Follow Up" tab active. */}
      {isOfficer ? <SchemePlanModeLinks mode="monitor" /> : <SchemeManagerModeLinks active="monitor" role={role} />}

      {/* Level 2 — Follow-up Type as a boxed segmented control (same style as the Create Plan "SCOPE" box). */}
      <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"><L k="scheme_planning.section.view" /></div>
        <div className="flex flex-wrap items-center gap-3"><PillNav value={tab} onChange={setTab} items={tabs} /></div>
      </div>

      {/* Level 3 — ONE shared Scheme-wise / Dealer-wise switch (clean underlined tabs), applied to the selected View. */}
      <UnderlineTabs value={rep} onChange={setRep} items={[{ value: "scheme", label: schemeWiseLbl }, { value: "dealer", label: dealerWiseLbl }]} />

      {isManager && (
        <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"><L k="scheme_planning.section.scope" /></div>
          <div className="flex flex-wrap items-center gap-3">
            <PillNav value={scope} onChange={(v) => { setScope(v); setOfficerId(""); }} items={[{ value: "self", label: myLbl }, { value: "team", label: teamLbl }]} />
            {scope === "team" && (
              <NativeSelect className="w-56" placeholder="Select a Sales Officer…" value={officerId} onChange={(e) => setOfficerId(e.target.value)} options={officers.map((o) => ({ value: o.id, label: o.name }))} />
            )}
          </div>
          {scope === "team" && officers.length === 0 && <p className="text-xs text-muted-foreground"><L k="scheme_planning.state.no_team_officers" /></p>}
        </div>
      )}

      {tab === "billing" ? (
        <SchemeSectionComingSoon title={billingLbl} badge={comingSoonLbl} />
      ) : tab === "payment" ? (
        <SchemeSectionComingSoon title={paymentLbl} badge={comingSoonLbl} />
      ) : isManager && scope === "team" && !officerId ? (
        <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">{selectOfficerLbl}</div>
      ) : (
        <SchemeConversionFollowUp key={effOfficer ?? "self"} role={role} officerId={effOfficer} representation={rep} />
      )}
    </div>
  );
}
