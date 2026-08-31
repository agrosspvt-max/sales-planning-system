"use client";

import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Clock, Pencil } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PillNav } from "@/features/planning/plan-list-ui";
import { L, useLabel } from "@/features/labels/label-ui";
import { PlanStateBadge, SchemeStatusBadge, MarkedValue, conversionDateCell, bookingCell, documentCell, billingDateCell, type SchemePlan } from "./scheme-detail-dialog";
import { schemeTable, verifyTint } from "./scheme-table-theme";
import { EnrolledSchemesView } from "./scheme-enrolled-view";
import { SchemePlanModeLinks, SchemePlanningView, toDateInput } from "./scheme-officer-workspace";

type ViewTab = "scheme" | "dealer" | "enrolled";

const dateTime = (s: string) => new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/**
 * Sales Officer — the VIEW PLAN side of Scheme Planning (/planning/scheme/plans), the counterpart to the
 * Create Plan route, matching how Sales Planning and Recovery Planning split their two workspaces.
 *
 *   View Plan
 *     ├── Scheme-wise ── the collapsible scheme → dealers table (the only view)
 *     ├── Dealer-wise  ── (later phase; the tab exists so it slots in without restructuring)
 *     └── Enrolled Scheme
 *
 * Every panel reads officer-scoped data: the server applies `getOfficerScope`, so an officer only ever
 * receives their own plans — no filtering happens in the browser.
 */
export function SchemeOfficerViewPlan() {
  const [tab, setTab] = useState<ViewTab>("scheme");
  const [planningId, setPlanningId] = useState<string | null>(null);
  // Labels resolved unconditionally (before the early return) so hook order is stable.
  const viewTabs: { value: ViewTab; label: string }[] = [
    { value: "scheme", label: useLabel("scheme_planning.view.scheme_wise") },
    { value: "dealer", label: useLabel("scheme_planning.view.dealer_wise") },
    { value: "enrolled", label: useLabel("scheme_planning.view.enrolled_scheme") },
  ];

  if (planningId) return <SchemePlanningView schemeId={planningId} onBack={() => setPlanningId(null)} />;

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Scheme Planning" }, { label: "View Plan" }]}
        title="Scheme Planning"
        subtitle="The schemes you have planned — approval, conversion and billing progress."
      />

      {/* Level 1 — Create New Plan | View Plans | Follow-up Plans */}
      <SchemePlanModeLinks mode="view" />

      {/* Level 2 — Scheme-wise | Dealer-wise | Enrolled Scheme. */}
      <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">View</div>
        <div className="flex flex-wrap items-center gap-3">
          <PillNav value={tab} onChange={setTab} items={viewTabs} />
        </div>
      </div>

      {tab === "enrolled" ? (
        <EnrolledSchemesView />
      ) : tab === "dealer" ? (
        <DealerWiseComingSoon />
      ) : (
        <SchemeWiseCollapsibleView onOpen={setPlanningId} />
      )}
    </div>
  );
}

/** Dealer-wise belongs to a later requirement; the tab is present so it can be filled in as-is. Shared with
 *  the Admin View Plan workspace so both roles show one placeholder rather than two copies of it. */
export function DealerWiseComingSoon() {
  return (
    <Card className="opacity-80">
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Clock className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="text-lg font-medium">Coming Soon</p>
        <p className="max-w-md text-sm text-muted-foreground">The Dealer-wise view is not available yet. Use Scheme-wise in the meantime.</p>
      </CardContent>
    </Card>
  );
}

/* --------------------------------- Scheme-wise · Collapsible View --------------------------------- */

/**
 * Scheme-wise COLLAPSIBLE VIEW — the officer's own plans grouped by scheme, each scheme a parent row that is
 * collapsed until clicked. This is the officer's former "My Schemes" tab, relocated to View Plan and rebuilt
 * on the parent-row → nested-table pattern already used by the Review workspace and the Enrolled view, so all
 * three collapsible scheme tables now share one visual language (schemeTable + the chevron convention).
 *
 * The parent row deliberately carries only what the old card header carried: scheme name, dealer count and the
 * Continue Planning / View action. Every plan / conversion / booking / document / billing detail stays in the
 * nested dealer table, unchanged — "Continue Planning" still opens the planning page and the Scheme Status
 * pencil (APPROVED plans only) still records conversion through ConversionModal.
 *
 * Read-only to load: one officer-scoped GET (`listSchemePlans` applies `getOfficerScope` server-side, so an
 * officer only ever receives their own plans). Expanding a row only renders data already fetched — no request,
 * and never `ensureInstances`/`expandInstances`, so a legacy plan cannot gain instances by being opened.
 */
/**
 * Reused by the Sales Officer (own plans) and, for a Regional Manager, by the RM View Plans shell:
 *   - `officerId` narrows to a single Sales Officer (My Schemes = the RM's own id; Team Schemes = a chosen
 *     team member). Server-validated, so it only ever restricts scope.
 *   - `groupByOfficer` (All Plans) groups per (scheme, officer), shows a Sales Officer column and lists the
 *     RM's own rows first — the team-wide view. `ownUserId` identifies those own rows for ordering.
 * Defaults reproduce the exact Sales Officer behaviour, so the SO view is unchanged.
 */
export function SchemeWiseCollapsibleView({ onOpen, officerId, groupByOfficer = false, ownUserId, showAction = true }: { onOpen: (id: string) => void; officerId?: string; groupByOfficer?: boolean; ownUserId?: string; showAction?: boolean }) {
  const qc = useQueryClient();
  const scopeKey = officerId ?? (groupByOfficer ? "team-all" : "mine");
  const { data, isLoading } = useQuery<SchemePlan[]>({ queryKey: ["scheme-plans", scopeKey], queryFn: () => api.get(`/api/scheme-plans${officerId ? `?officerId=${encodeURIComponent(officerId)}` : ""}`) });
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; schemeId: string; schemeName: string; salesOfficerId: string | null; salesOfficerName: string | null; plans: SchemePlan[] }>();
    for (const p of data ?? []) {
      const key = groupByOfficer ? `${p.schemeId}::${p.salesOfficerId}` : p.schemeId;
      const g = map.get(key) ?? { key, schemeId: p.schemeId, schemeName: p.schemeName, salesOfficerId: groupByOfficer ? p.salesOfficerId : null, salesOfficerName: groupByOfficer ? p.salesOfficerName : null, plans: [] };
      g.plans.push(p);
      map.set(key, g);
    }
    const arr = [...map.values()];
    if (groupByOfficer) {
      arr.sort((a, b) => {
        const own = (a.salesOfficerId === ownUserId ? 0 : 1) - (b.salesOfficerId === ownUserId ? 0 : 1);
        if (own !== 0) return own;
        const byOfficer = (a.salesOfficerName ?? "").localeCompare(b.salesOfficerName ?? "");
        return byOfficer !== 0 ? byOfficer : a.schemeName.localeCompare(b.schemeName);
      });
    }
    return arr;
  }, [data, groupByOfficer, ownUserId]);

  const cols = groupByOfficer ? 5 : 4; // chevron + Scheme + Dealers (+ Sales Officer) + Actions
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // collapsed by default
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const [convert, setConvert] = useState<SchemePlan | null>(null);

  return (
    <>
      <div className={schemeTable.outer}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead><L k="scheme_planning.col.scheme" /></TableHead>
              <TableHead><L k="scheme_planning.col.dealers" /></TableHead>
              {groupByOfficer && <TableHead><L k="scheme_planning.nested.sales_officer" /></TableHead>}
              <TableHead className="text-right"><L k="scheme_planning.col.actions" /></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={cols}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : groups.length === 0 ? (
              <TableRow><TableCell colSpan={cols} className="py-10 text-center text-muted-foreground">No scheme plans yet.</TableCell></TableRow>
            ) : (
              groups.map((g) => {
                const editable = g.plans.some((p) => p.planStatus === "DRAFT" || p.planStatus === "RETURNED");
                const open = expanded.has(g.key);
                return (
                  <Fragment key={g.key}>
                    {/* Parent row — scheme name, dealer count and the officer's existing Continue Planning / View action. */}
                    <TableRow className={cn("cursor-pointer", schemeTable.parentRow, open && schemeTable.parentRowOpen)} onClick={() => toggle(g.key)}>
                      <TableCell>{open ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                      <TableCell className="font-semibold">{g.schemeName}</TableCell>
                      <TableCell>{g.plans.length} Dealer{g.plans.length === 1 ? "" : "s"}</TableCell>
                      {groupByOfficer && <TableCell>{g.salesOfficerName ?? "—"}{g.salesOfficerId === ownUserId && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}</TableCell>}
                      {/* stopPropagation so using the action never toggles the row underneath it. */}
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        {showAction ? <Button size="sm" variant="outline" onClick={() => onOpen(g.schemeId)}>{editable ? "Continue Planning" : "View"}</Button> : <span className="text-xs text-muted-foreground">Expand to view</span>}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow>
                        <TableCell colSpan={cols} className={schemeTable.nestedCell}>
                          <div className={schemeTable.nestedInset}>
                            <div className={schemeTable.nestedShell}>
                            <Table>
                              <TableHeader>
                                {/* Grouping band: plan info | Scheme Status | the four SO conversion details (Admin-final shown once verified). */}
                                <TableRow className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                  <TableHead colSpan={7} />
                                  <TableHead colSpan={4} className="border-l text-center">Conversion Details · SO / Admin-final</TableHead>
                                </TableRow>
                                <TableRow>
                                  <TableHead><L k="scheme_planning.nested.dealer" /></TableHead>
                                  <TableHead><L k="scheme_planning.nested.planned_conversion" /></TableHead>
                                  <TableHead className="text-right"><L k="scheme_planning.nested.schemes" /></TableHead>
                                  <TableHead className="text-right"><L k="scheme_planning.nested.total_amount" /></TableHead>
                                  <TableHead><L k="scheme_planning.nested.planning_date" /></TableHead>
                                  <TableHead><L k="scheme_planning.nested.plan_status" /></TableHead>
                                  <TableHead><L k="scheme_planning.nested.scheme_status" /></TableHead>
                                  <TableHead className={verifyTint.conversion.head}><L k="scheme_planning.nested.conversion_date" /></TableHead>
                                  <TableHead className={verifyTint.booking.head}><L k="scheme_planning.nested.booking_amount" /></TableHead>
                                  <TableHead className={verifyTint.document.head}><L k="scheme_planning.nested.document_status" /></TableHead>
                                  <TableHead className={verifyTint.billing.head}><L k="scheme_planning.nested.billing_date" /></TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {g.plans.map((p) => (
                                  <TableRow key={p.id}>
                                    <TableCell className="font-medium">{p.dealerName}</TableCell>
                                    <TableCell>{p.expectedBillingDate ? formatDate(p.expectedBillingDate) : <span className="text-muted-foreground">—</span>}</TableCell>
                                    <TableCell className="text-right tabular-nums">{p.numberOfSchemes}</TableCell>
                                    <TableCell className="text-right tabular-nums">{formatCurrency(p.totalSchemeAmount)}</TableCell>
                                    <TableCell>{p.planningDate ? dateTime(p.planningDate) : <span className="text-muted-foreground">—</span>}</TableCell>
                                    <TableCell><PlanStateBadge status={p.planStatus} /></TableCell>
                                    <TableCell>
                                      {p.planStatus === "APPROVED" ? (
                                        <button type="button" className="inline-flex items-center gap-1" title="Set scheme status" onClick={() => setConvert(p)}>
                                          <SchemeStatusBadge plan={p} />
                                          <Pencil className="h-3 w-3 text-muted-foreground" />
                                        </button>
                                      ) : <span className="text-muted-foreground">—</span>}
                                    </TableCell>
                                    <TableCell className={cn("whitespace-nowrap", verifyTint.conversion.cell)}><MarkedValue v={conversionDateCell(p)} /></TableCell>
                                    <TableCell className={cn("whitespace-nowrap", verifyTint.booking.cell)}><MarkedValue v={bookingCell(p)} /></TableCell>
                                    <TableCell className={cn("whitespace-nowrap", verifyTint.document.cell)}><MarkedValue v={documentCell(p)} /></TableCell>
                                    <TableCell className={cn("whitespace-nowrap", verifyTint.billing.cell)}><MarkedValue v={billingDateCell(p)} /></TableCell>
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
      {convert && <ConversionModal plan={convert} onClose={() => setConvert(null)} onSaved={() => { setConvert(null); qc.invalidateQueries({ queryKey: ["scheme-plans"] }); }} />}
    </>
  );
}

/* --------------------------------- SO conversion entry --------------------------------- */

/** SO conversion entry: set Scheme Status and (when Converted) record conversion details + billing date(s). */
function ConversionModal({ plan, onClose, onSaved }: { plan: SchemePlan; onClose: () => void; onSaved: () => void }) {
  const count = plan.numberOfSchemes || 1;
  const multi = count > 1;
  const [schemeStatus, setSchemeStatus] = useState(plan.schemeStatus === "PENDING" ? "CONVERTED" : plan.schemeStatus);
  const [conversionDate, setConversionDate] = useState(toDateInput(plan.conversionDate));
  const [booking, setBooking] = useState(plan.soBookingStatus ?? "RECEIVED");
  const [bookingAmount, setBookingAmount] = useState(plan.soBookingAmount != null ? String(plan.soBookingAmount) : "");
  const [doc, setDoc] = useState(plan.soDocumentStatus ?? "SIGNED_AND_SENT");
  const [sameForAll, setSameForAll] = useState(plan.soBillingSameForAll ?? true);
  const [billingDate, setBillingDate] = useState(toDateInput(plan.billingDate ?? plan.instances.find((i) => i.instanceNumber === 1)?.soBillingDate ?? null));
  const [instDates, setInstDates] = useState<Record<number, string>>(() => {
    const m: Record<number, string> = {};
    for (const i of plan.instances) m[i.instanceNumber] = toDateInput(i.soBillingDate);
    return m;
  });
  const [error, setError] = useState<string | null>(null);
  const converting = schemeStatus === "CONVERTED";

  const perInstance = multi && !sameForAll;
  const instNums = Array.from({ length: count }, (_, i) => i + 1);
  const billingComplete = !converting || (perInstance ? instNums.every((n) => !!instDates[n]) : !!billingDate);
  const partialInvalid = converting && booking === "PARTIAL" && !bookingAmount;

  const save = useMutation({
    mutationFn: () => api.patch(`/api/scheme-plans/${plan.id}/conversion`, {
      schemeStatus,
      conversionDate: converting ? (conversionDate || null) : null,
      soBookingStatus: converting ? booking : null,
      soBookingAmount: converting && booking === "PARTIAL" ? Number(bookingAmount) : (converting && bookingAmount ? Number(bookingAmount) : null),
      soDocumentStatus: converting ? doc : null,
      billingSameForAll: !perInstance,
      billingDate: converting && !perInstance ? (billingDate || null) : null,
      billingDates: converting && perInstance ? instNums.map((n) => ({ instanceNumber: n, date: instDates[n] || null })) : undefined,
    }),
    onSuccess: onSaved,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{plan.schemeName} — {plan.dealerName}{multi ? ` · ${count} Schemes` : ""}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Scheme Status *</Label>
            <NativeSelect value={schemeStatus} onChange={(e) => setSchemeStatus(e.target.value)} options={[{ value: "PENDING", label: "Pending" }, { value: "CONVERTED", label: "Converted" }, { value: "DECLINED", label: "Declined" }]} />
          </div>
          {converting && (
            <>
              <div className="space-y-1.5"><Label>Conversion Date</Label><Input type="date" value={conversionDate} onChange={(e) => setConversionDate(e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label>Booking Amount</Label><NativeSelect value={booking} onChange={(e) => setBooking(e.target.value)} options={[{ value: "RECEIVED", label: "Received" }, { value: "NOT_RECEIVED", label: "Not Received" }, { value: "PARTIAL", label: "Partial Received" }]} /></div>
                {booking === "PARTIAL" && <div className="space-y-1.5"><Label>Partial Amount *</Label><Input type="number" min="0" value={bookingAmount} onChange={(e) => setBookingAmount(e.target.value)} /></div>}
              </div>
              <div className="space-y-1.5"><Label>Document Status</Label><NativeSelect value={doc} onChange={(e) => setDoc(e.target.value)} options={[{ value: "SIGNED_BUT_NOT_SENT", label: "Signed but not Sent" }, { value: "SIGNED_AND_SENT", label: "Signed & Sent" }, { value: "DOC_RECEIVED", label: "Doc Received" }]} /></div>

              {multi && (
                <div className="space-y-1.5">
                  <Label>Is Billing Date same for all schemes?</Label>
                  <NativeSelect className="w-28" value={sameForAll ? "yes" : "no"} onChange={(e) => setSameForAll(e.target.value === "yes")} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
                </div>
              )}
              {perInstance ? (
                <div className="space-y-1.5">
                  <Label>Billing Dates</Label>
                  <div className="space-y-1.5 rounded-md border p-2">
                    {instNums.map((n) => (
                      <div key={n} className="flex items-center gap-2">
                        <span className="w-20 text-sm text-muted-foreground">Scheme {n}</span>
                        <Input type="date" value={instDates[n] ?? ""} onChange={(e) => setInstDates((p) => ({ ...p, [n]: e.target.value }))} />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5"><Label>Billing Date{multi ? " (all schemes)" : ""}</Label><Input type="date" value={billingDate} onChange={(e) => setBillingDate(e.target.value)} /></div>
              )}
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground">No approval is required after this — these values are visible to your RM and Admin, who verifies them.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending || partialInvalid || !billingComplete} onClick={() => { setError(null); save.mutate(); }}>{save.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
