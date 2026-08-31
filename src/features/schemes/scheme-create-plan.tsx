"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, FileText, Info, MessageCircle, MoreVertical, Plus, Save, Send, Share2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PlanStateBadge, type SchemePlan } from "./scheme-detail-dialog";
import { L } from "@/features/labels/label-ui";
import { schemeTable } from "./scheme-table-theme";

/**
 * CREATE PLAN — the scheme → dealer planning workspace (/planning/scheme for a Sales Officer, and the
 * Regional Manager's "Running Schemes" tab).
 *
 *   ▶ test3                                    3 Dealers        [+ Add Dealer]  [⋮]
 *   ▼ test3                                    3 Dealers        [+ Add Dealer]  [⋮]
 *       | Dealer Name | Conversion Date | Number of Schemes | Total Amount | Status |
 *       | jai bajrang | 26 Aug 2026     | 1                 | ₹1,18,000    | Draft  |
 *       + Add Dealer                              [Save Draft]  [Submit]
 *
 * It replaces the old "View Scheme" drill-down (a whole page per scheme with a large Select Dealers
 * checkbox table) with one collapsible list, on the SAME parent-row → nested-table pattern already used by
 * the Review workspace, the Enrolled view and View Plan → Scheme-wise (`schemeTable` + the chevron
 * convention). Dealers are added one at a time through a "Choose Dealer" modal.
 *
 * NOTHING here re-implements business logic:
 *   dealer scope      — `GET /api/schemes/{id}/planning[?officerId=]` (`planningContext` → DealerAssignment
 *                       of the target officer, with `resolveTargetOfficer` enforcing the RM "My Team" rule
 *                       server-side). The Choose Dealer list is exactly that list; nothing is scoped here.
 *   conversion date   — `expectedBillingDate`, bounded by the scheme's own start/end dates (also re-checked
 *                       server-side by `validateDate`).
 *   number of schemes — selectable 1–10 only while the scheme allows multiples; otherwise fixed at 1, which
 *                       is what `countFor` enforces server-side.
 *   total amount      — schemeValueWithGST × number of schemes, the same formula `persistDraft` persists to
 *                       `totalSchemeAmount` (locked rows show the stored value instead of a recomputation).
 *   draft / submit    — the existing `/api/scheme-plans/save-draft` and `/api/scheme-plans/submit-draft`.
 *   returned plans    — `RETURNED` is in the server's EDITABLE set, so a returned dealer is editable and
 *                       re-submittable here exactly like a draft.
 *
 * Reads on load: `GET /api/schemes/running` + `GET /api/scheme-plans` (both already role-scoped server-side).
 * Expanding a scheme and opening Info render data already fetched — no request, so neither can trigger the
 * `refreshSchemeStatuses()` write that every scheme read path performs, and neither can touch instances.
 */

const BENEFIT_LABEL: Record<string, string> = { DOMESTIC_TOUR: "Domestic Tour", DOMESTIC_COUPLE_TOUR: "Domestic Couple Tour", FOREIGN_TOUR: "Foreign Tour", CREDIT_NOTE: "Credit Note", OTHER: "Other" };
const CALC_LABEL: Record<string, string> = { PERCENTAGE: "Percentage", FIXED_AMOUNT: "Fixed Amount" };
/** Plan states whose dealer row the owner may still edit — mirrors the server's EDITABLE set. */
const EDITABLE = new Set(["DRAFT", "RETURNED"]);
/** ISO timestamp → the `yyyy-mm-dd` an <input type="date"> needs (file-local, as in the sibling views). */
const toDateInput = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : "");

/** A running scheme, as returned by `/api/schemes/running`. Exported so the Scheme Master menu can reuse
 *  the exact same Info / Document / Share dialogs (its rows are adapted to this shape). */
export interface RunningScheme {
  id: string; schemeName: string; states: string[]; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null;
  schemeBenefit: string; benefitDetails: string | null; schemeValueWithoutGST: number; schemeValueWithGST: number; documentUrl: string | null;
  bookingAmount: number | null; otherBenefitDetails: string | null; allowMultipleSchemes: boolean;
  installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
}

/** The planning context for one scheme — used only to populate "Choose Dealer". */
interface PlanningCtx {
  dealers: { id: string; name: string; territory: string | null }[];
  existing: { dealerId: string; planStatus: string }[];
}

/** One dealer line inside an expanded scheme. `planStatus === null` → added on screen, not yet saved. */
interface DealerRow {
  dealerId: string;
  dealerName: string;
  /** Owning Sales Officer — shown only in the organization-wide read-only panel. */
  officerName: string | null;
  planStatus: string | null;
  date: string;
  count: number;
  storedTotal: number | null;
  editable: boolean;
}

const rowKey = (schemeId: string, dealerId: string) => `${schemeId}:${dealerId}`;

/* --------------------------------- Workspace --------------------------------- */

/**
 * @param enableRmScope  Regional Manager only — show the My Dealers / My Team → Sales Officer scope control.
 * @param readOnly       Super Admin's Create Plan panel: the same collapsible structure and the same scheme
 *                       actions (Info / View Document / Share), but purely for looking at. No Add Dealer, no
 *                       editable cells, no Save Draft / Submit — an Admin authors schemes in Scheme Master and
 *                       acts on plans in View Plan, so this panel must not become an SO-scoped planning tool.
 * @param userId         The signed-in user, used only to pick the RM's own rows out of their team's plans.
 */
export function SchemeCreatePlanWorkspace({ enableRmScope = false, readOnly = false, userId, controlledOfficerId, hideScopeSelector = false }: { enableRmScope?: boolean; readOnly?: boolean; userId?: string; controlledOfficerId?: string; hideScopeSelector?: boolean }) {
  const qc = useQueryClient();

  // RM "My Dealers" (self) vs "My Team" (a chosen Sales Officer). Sales Officers never see this — same
  // control, same endpoint and same semantics as the previous planning page.
  //
  // CONTROLLED MODE (`hideScopeSelector`): the RM Scheme Planning shell owns the My Schemes / Team Schemes
  // choice and passes the resolved officer as `controlledOfficerId`. The internal Dealer Scope card is then
  // hidden and every officer-derived value below reads from the prop instead of local state. The shell
  // remounts this component per officer (React key), so no reset effect is needed. `undefined`/self = the
  // caller plans for themselves; any other id = plan on behalf of that team Sales Officer.
  const [scope, setScope] = useState<"self" | "team">("self");
  const [officerId, setOfficerId] = useState("");
  const controlled = hideScopeSelector;
  const teamMode = controlled ? (!!controlledOfficerId && controlledOfficerId !== userId) : (enableRmScope && scope === "team");
  const targetOfficer = controlled ? (teamMode ? (controlledOfficerId ?? "") : "") : (scope === "team" ? officerId : "");
  const { data: officers } = useQuery<{ id: string; name: string }[]>({ queryKey: ["scheme-team-officers"], queryFn: () => api.get("/api/schemes/team-officers"), enabled: enableRmScope && !controlled });

  const { data: schemes, isLoading } = useQuery<RunningScheme[]>({ queryKey: ["running-schemes"], queryFn: () => api.get("/api/schemes/running") });
  // Same endpoint and cache namespace the other views use: "mine" for a Sales Officer, "all" for the manager
  // roles. Scoping happens server-side in `listSchemePlans` (getOfficerScope) — never in the browser.
  const { data: plans } = useQuery<SchemePlan[]>({ queryKey: ["scheme-plans", enableRmScope || readOnly ? "all" : "mine"], queryFn: () => api.get("/api/scheme-plans") });

  // Which officer's rows this screen is planning. A Sales Officer only ever receives their own plans and the
  // Admin panel is deliberately organization-wide, so neither narrows; an RM receives their whole team from
  // the server and plans for one member at a time.
  const rowsOfficer = controlled ? (controlledOfficerId ?? userId ?? "") : (enableRmScope ? (teamMode ? officerId : userId ?? "") : null);
  const plansForOfficer = useMemo(
    () => (plans ?? []).filter((p) => (rowsOfficer ? p.salesOfficerId === rowsOfficer : true)),
    [plans, rowsOfficer],
  );

  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // collapsed by default
  const toggle = (schemeId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(schemeId)) next.delete(schemeId);
      else next.add(schemeId);
      return next;
    });

  // Working state layered OVER the server rows, so a refetch can never clobber an untouched edit.
  const [edits, setEdits] = useState<Record<string, { date?: string; count?: number }>>({});
  const [added, setAdded] = useState<Record<string, { dealerId: string; dealerName: string }[]>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const [addFor, setAddFor] = useState<RunningScheme | null>(null);
  const [infoFor, setInfoFor] = useState<RunningScheme | null>(null);
  const [docFor, setDocFor] = useState<RunningScheme | null>(null);
  const [shareFor, setShareFor] = useState<RunningScheme | null>(null);
  const [confirm, setConfirm] = useState<{ scheme: RunningScheme; complete: DealerRow[]; incomplete: DealerRow[] } | null>(null);

  // Switching officer discards the (now irrelevant) working state rather than applying it to someone else.
  const resetWork = () => { setEdits({}); setAdded({}); setRemoved(new Set()); setErrors({}); };
  const clearScheme = (schemeId: string) => {
    const prefix = `${schemeId}:`;
    setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(prefix))));
    setAdded((prev) => { const next = { ...prev }; delete next[schemeId]; return next; });
    setRemoved((prev) => new Set([...prev].filter((k) => !k.startsWith(prefix))));
    setErrors((prev) => ({ ...prev, [schemeId]: null }));
  };

  /** Server rows + local additions − local removals, with local edits applied. */
  const rowsFor = (scheme: RunningScheme): DealerRow[] => {
    const out: DealerRow[] = [];
    for (const p of plansForOfficer) {
      if (p.schemeId !== scheme.id) continue;
      const key = rowKey(scheme.id, p.dealerId);
      if (removed.has(key)) continue;
      const editable = EDITABLE.has(p.planStatus) && !readOnly;
      out.push({
        dealerId: p.dealerId,
        dealerName: p.dealerName,
        officerName: p.salesOfficerName,
        planStatus: p.planStatus,
        date: edits[key]?.date ?? toDateInput(p.expectedBillingDate),
        count: edits[key]?.count ?? (p.numberOfSchemes || 1),
        storedTotal: p.totalSchemeAmount,
        editable,
      });
    }
    for (const a of added[scheme.id] ?? []) {
      const key = rowKey(scheme.id, a.dealerId);
      out.push({ dealerId: a.dealerId, dealerName: a.dealerName, officerName: null, planStatus: null, date: edits[key]?.date ?? "", count: edits[key]?.count ?? 1, storedTotal: null, editable: true });
    }
    return out.sort((a, b) => a.dealerName.localeCompare(b.dealerName));
  };

  const setDate = (schemeId: string, dealerId: string, date: string) =>
    setEdits((prev) => { const k = rowKey(schemeId, dealerId); return { ...prev, [k]: { ...prev[k], date } }; });
  const setCount = (schemeId: string, dealerId: string, count: number) =>
    setEdits((prev) => { const k = rowKey(schemeId, dealerId); return { ...prev, [k]: { ...prev[k], count } }; });

  /** Drop a dealer from the working set: an unsaved addition disappears, a saved draft/returned row is
   *  removed on the next save (which is what the existing server does with a de-selected editable row). */
  const dropRow = (schemeId: string, row: DealerRow) => {
    if (row.planStatus === null) {
      setAdded((prev) => ({ ...prev, [schemeId]: (prev[schemeId] ?? []).filter((a) => a.dealerId !== row.dealerId) }));
      return;
    }
    setRemoved((prev) => new Set(prev).add(rowKey(schemeId, row.dealerId)));
  };

  const removedCount = (schemeId: string) => [...removed].filter((k) => k.startsWith(`${schemeId}:`)).length;

  const save = useMutation({
    mutationFn: (v: { schemeId: string; rows: DealerRow[]; submitIds?: string[] }) =>
      api.post(v.submitIds ? "/api/scheme-plans/submit-draft" : "/api/scheme-plans/save-draft", {
        schemeId: v.schemeId,
        officerId: targetOfficer || undefined,
        // The whole editable working set is always sent, so nothing the officer can still edit is dropped.
        dealers: v.rows.map((r) => ({ dealerId: r.dealerId, expectedBillingDate: r.date || null, numberOfSchemes: r.count })),
        ...(v.submitIds ? { submitDealerIds: v.submitIds } : {}),
      }),
    onSuccess: (_res, v) => {
      clearScheme(v.schemeId);
      qc.invalidateQueries({ queryKey: ["scheme-plans"] });
      qc.invalidateQueries({ queryKey: ["scheme-planning", v.schemeId] });
    },
    onError: (e, v) => setErrors((prev) => ({ ...prev, [v.schemeId]: (e as Error).message })),
  });
  const busy = (schemeId: string) => save.isPending && save.variables?.schemeId === schemeId;

  const runSave = (scheme: RunningScheme, rows: DealerRow[]) => {
    setErrors((prev) => ({ ...prev, [scheme.id]: null }));
    save.mutate({ schemeId: scheme.id, rows: rows.filter((r) => r.editable) });
  };

  /**
   * Submit. Only dealers with a Conversion Date can go forward; if any editable dealer is incomplete we ask
   * first (§ "Do NOT silently discard them") and, on confirmation, submit the complete ones while the
   * incomplete ones are still saved as Draft — one call, so the officer never loses work either way.
   */
  const runSubmit = (scheme: RunningScheme, rows: DealerRow[]) => {
    setErrors((prev) => ({ ...prev, [scheme.id]: null }));
    const editable = rows.filter((r) => r.editable);
    const complete = editable.filter((r) => !!r.date);
    const incomplete = editable.filter((r) => !r.date);
    if (incomplete.length > 0) { setConfirm({ scheme, complete, incomplete }); return; }
    save.mutate({ schemeId: scheme.id, rows: editable, submitIds: complete.map((r) => r.dealerId) });
  };

  const takenFor = (scheme: RunningScheme) => new Set(rowsFor(scheme).map((r) => r.dealerId));

  /** Device/browser sharing — a real attachment where the platform allows it, else the app's wa.me + copy
   *  fallback dialog. No messaging API, no server involvement. */
  const share = async (scheme: RunningScheme) => {
    const text = schemeShareText(scheme);
    const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { canShare?: (d: ShareData) => boolean });
    const file = schemeDocumentFile(scheme);
    if (nav && file && nav.canShare?.({ files: [file] })) {
      try { await nav.share({ files: [file], title: scheme.schemeName, text }); return; } catch (e) { if ((e as Error).name === "AbortError") return; }
    }
    if (nav && typeof nav.share === "function") {
      try { await nav.share({ title: scheme.schemeName, text }); return; } catch (e) { if ((e as Error).name === "AbortError") return; }
    }
    setShareFor(scheme);
  };

  const waitingForOfficer = !controlled && teamMode && !officerId;

  return (
    <div className="space-y-4">
      {enableRmScope && !controlled && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Dealer Scope</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label>Dealer Scope</Label>
                <NativeSelect className="w-44" value={scope} onChange={(e) => { setScope(e.target.value as "self" | "team"); setOfficerId(""); resetWork(); }} options={[{ value: "self", label: "My Dealers" }, { value: "team", label: "My Team" }]} />
              </div>
              {scope === "team" && (
                <div className="space-y-1.5">
                  <Label>Sales Officer</Label>
                  <NativeSelect className="w-56" placeholder="Select a Sales Officer…" value={officerId} onChange={(e) => { setOfficerId(e.target.value); resetWork(); }} options={(officers ?? []).map((o) => ({ value: o.id, label: o.name }))} />
                </div>
              )}
            </div>
            {scope === "team" && (officers?.length ?? 0) === 0 && <p className="mt-2 text-xs text-muted-foreground">No Sales Officers on your team yet.</p>}
          </CardContent>
        </Card>
      )}

      {waitingForOfficer ? (
        <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">Select a Sales Officer to plan their dealers.</div>
      ) : (
        <div className={schemeTable.outer}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead><L k="scheme_planning.col.scheme" /></TableHead>
                <TableHead><L k="scheme_planning.col.dealers" /></TableHead>
                <TableHead className="text-right"><L k="scheme_planning.col.actions" /></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              ) : (schemes?.length ?? 0) === 0 ? (
                <TableRow><TableCell colSpan={4} className="py-10 text-center text-muted-foreground">{readOnly ? "No running schemes." : "No running schemes for your State."}</TableCell></TableRow>
              ) : (
                schemes!.map((s) => {
                  const open = expanded.has(s.id);
                  const rows = rowsFor(s);
                  const editable = rows.filter((r) => r.editable);
                  const complete = editable.filter((r) => !!r.date);
                  const pendingRemoval = removedCount(s.id);
                  const dirty = editable.length > 0 || pendingRemoval > 0;
                  const minDate = s.startDate ? toDateInput(s.startDate) : undefined;
                  const maxDate = !s.isPerpetual && s.endDate ? toDateInput(s.endDate) : undefined;
                  return (
                    <Fragment key={s.id}>
                      {/* Parent row — scheme name, dealer count, and the actions that replaced "View Scheme". */}
                      <TableRow className={cn("cursor-pointer", schemeTable.parentRow, open && schemeTable.parentRowOpen)} onClick={() => toggle(s.id)}>
                        <TableCell>{open ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                        <TableCell className="font-semibold">{s.schemeName}</TableCell>
                        <TableCell>{rows.length} Dealer{rows.length === 1 ? "" : "s"}</TableCell>
                        {/* stopPropagation so using an action never toggles the row underneath it. */}
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            {!readOnly && <Button size="sm" variant="outline" onClick={() => { setExpanded((prev) => new Set(prev).add(s.id)); setAddFor(s); }}><Plus className="h-4 w-4" /> Add Dealer</Button>}
                            <SchemeActionsMenu scheme={s} onInfo={() => setInfoFor(s)} onDocument={() => setDocFor(s)} onShare={() => void share(s)} />
                          </div>
                        </TableCell>
                      </TableRow>

                      {open && (
                        <TableRow>
                          <TableCell colSpan={4} className={schemeTable.nestedCell}>
                            <div className={schemeTable.nestedInset}>
                              <div className={schemeTable.nestedShell}>
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Dealer Name</TableHead>
                                      {/* Organization-wide panel only: whose plan each dealer row is. */}
                                      {readOnly && <TableHead>Sales Officer</TableHead>}
                                      <TableHead>Conversion Date</TableHead>
                                      <TableHead>Number of Schemes</TableHead>
                                      <TableHead className="text-right">Total Amount</TableHead>
                                      <TableHead>Status</TableHead>
                                      {!readOnly && <TableHead className="w-10" />}
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {rows.length === 0 ? (
                                      <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">{readOnly ? "No dealers planned into this scheme yet." : "No dealers planned into this scheme yet — use Add Dealer to start."}</TableCell></TableRow>
                                    ) : (
                                      rows.map((r) => (
                                        <TableRow key={r.dealerId}>
                                          <TableCell className="font-medium">{r.dealerName}</TableCell>
                                          {readOnly && <TableCell>{r.officerName ?? "—"}</TableCell>}
                                          <TableCell>
                                            {r.editable ? (
                                              <Input type="date" className="w-44" min={minDate} max={maxDate} value={r.date} onChange={(e) => setDate(s.id, r.dealerId, e.target.value)} />
                                            ) : r.date ? formatDate(r.date) : <span className="text-muted-foreground">—</span>}
                                          </TableCell>
                                          <TableCell>
                                            {r.editable && s.allowMultipleSchemes ? (
                                              <NativeSelect className="w-20" value={String(r.count)} onChange={(e) => setCount(s.id, r.dealerId, Number(e.target.value))} options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
                                            ) : <span className="tabular-nums">{r.count}</span>}
                                          </TableCell>
                                          <TableCell className="text-right tabular-nums">{formatCurrency(r.editable ? s.schemeValueWithGST * r.count : r.storedTotal ?? s.schemeValueWithGST * r.count)}</TableCell>
                                          <TableCell>{r.planStatus ? <PlanStateBadge status={r.planStatus} /> : <Badge variant="muted">New</Badge>}</TableCell>
                                          {!readOnly && (
                                            <TableCell className="text-right">
                                              {r.editable && (
                                                <Button variant="ghost" size="sm" title="Remove this dealer from the plan" onClick={() => dropRow(s.id, r)}><X className="h-4 w-4" /></Button>
                                              )}
                                            </TableCell>
                                          )}
                                        </TableRow>
                                      ))
                                    )}
                                  </TableBody>
                                </Table>
                              </div>

                              {/* + Add Dealer sits below the rows; dealers are added one at a time. */}
                              {!readOnly && (
                                <>
                                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                                    <Button size="sm" variant="outline" onClick={() => setAddFor(s)}><Plus className="h-4 w-4" /> Add Dealer</Button>
                                    <div className="flex items-center gap-2">
                                      <Button size="sm" variant="outline" disabled={busy(s.id) || !dirty} onClick={() => runSave(s, rows)}><Save className="h-4 w-4" /> {busy(s.id) ? "Saving…" : "Save Draft"}</Button>
                                      <Button size="sm" disabled={busy(s.id) || complete.length === 0} onClick={() => runSubmit(s, rows)}><Send className="h-4 w-4" /> {busy(s.id) ? "Submitting…" : "Submit"}</Button>
                                    </div>
                                  </div>
                                  {pendingRemoval > 0 && <p className="mt-2 text-xs text-muted-foreground">{pendingRemoval} dealer{pendingRemoval === 1 ? "" : "s"} will be removed from this plan when you save.</p>}
                                  {editable.length > 0 && complete.length === 0 && <p className="mt-2 text-xs text-muted-foreground">Add a Conversion Date to a dealer before submitting.</p>}
                                  {errors[s.id] && <p className="mt-2 text-sm text-destructive">{errors[s.id]}</p>}
                                </>
                              )}
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

      {addFor && (
        <ChooseDealerDialog
          scheme={addFor}
          officerId={targetOfficer}
          taken={takenFor(addFor)}
          onAdd={(d) => {
            setAdded((prev) => ({ ...prev, [addFor.id]: [...(prev[addFor.id] ?? []), d] }));
            setExpanded((prev) => new Set(prev).add(addFor.id));
            setAddFor(null);
          }}
          onClose={() => setAddFor(null)}
        />
      )}
      {infoFor && <SchemeInfoDialog scheme={infoFor} onClose={() => setInfoFor(null)} />}
      {docFor && <SchemeDocumentDialog scheme={docFor} onClose={() => setDocFor(null)} />}
      {shareFor && <SchemeShareDialog scheme={shareFor} onClose={() => setShareFor(null)} />}
      {confirm && (
        <IncompleteSubmitDialog
          scheme={confirm.scheme}
          complete={confirm.complete}
          incomplete={confirm.incomplete}
          pending={save.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            save.mutate({ schemeId: c.scheme.id, rows: [...c.complete, ...c.incomplete], submitIds: c.complete.map((r) => r.dealerId) });
          }}
        />
      )}
    </div>
  );
}

/* --------------------------------- ⋮ menu --------------------------------- */

/** Scheme-level actions. Info and View Document keep the scheme information reachable now that the row's
 *  action is Add Dealer rather than View Scheme. */
function SchemeActionsMenu({ scheme, onInfo, onDocument, onShare }: { scheme: RunningScheme; onInfo: () => void; onDocument: () => void; onShare: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" title="More actions"><MoreVertical className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onInfo}><Info className="h-4 w-4" /> Info</DropdownMenuItem>
        <DropdownMenuItem disabled={!scheme.documentUrl} onSelect={onDocument}><FileText className="h-4 w-4" /> View Document</DropdownMenuItem>
        <DropdownMenuItem onSelect={onShare}><Share2 className="h-4 w-4" /> Share</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* --------------------------------- Choose Dealer --------------------------------- */

/**
 * "Choose Dealer" — one dealer at a time. The options ARE the existing dealer scope: `planningContext`
 * resolves the target officer server-side (an RM may only target their own team) and returns that officer's
 * active DealerAssignment dealers. Dealers already planned into this scheme are excluded, because
 * DealerSchemePlan is unique on (scheme, dealer).
 */
function ChooseDealerDialog({ scheme, officerId, taken, onAdd, onClose }: {
  scheme: RunningScheme;
  officerId: string;
  taken: Set<string>;
  onAdd: (d: { dealerId: string; dealerName: string }) => void;
  onClose: () => void;
}) {
  const [dealerId, setDealerId] = useState("");
  const { data, isLoading } = useQuery<PlanningCtx>({
    queryKey: ["scheme-planning", scheme.id, officerId || "self"],
    queryFn: () => api.get(`/api/schemes/${scheme.id}/planning${officerId ? `?officerId=${encodeURIComponent(officerId)}` : ""}`),
  });

  const alreadyPlanned = useMemo(() => new Set((data?.existing ?? []).map((e) => e.dealerId)), [data]);
  const options = (data?.dealers ?? []).filter((d) => !taken.has(d.id) && !alreadyPlanned.has(d.id));
  const chosen = options.find((d) => d.id === dealerId);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Dealer — {scheme.schemeName}</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <Label>Choose Dealer</Label>
          {isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <NativeSelect
              placeholder="Select a dealer…"
              value={dealerId}
              onChange={(e) => setDealerId(e.target.value)}
              options={options.map((d) => ({ value: d.id, label: d.territory ? `${d.name} · ${d.territory}` : d.name }))}
            />
          )}
          {!isLoading && options.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {(data?.dealers.length ?? 0) === 0 ? "No dealers are assigned to this Sales Officer." : "Every assigned dealer is already planned into this scheme."}
            </p>
          )}
          <p className="text-xs text-muted-foreground">Set the Conversion Date and Number of Schemes on the dealer row after adding.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!chosen} onClick={() => chosen && onAdd({ dealerId: chosen.id, dealerName: chosen.name })}>Add Dealer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------- Info --------------------------------- */

/** Scheme Information — the same fields the planning page's "Scheme Details" card shows, from the same
 *  scheme record. Presentation only: no field is invented and nothing is fetched to render it. */
export function SchemeInfoDialog({ scheme, onClose }: { scheme: RunningScheme; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Scheme Information — {scheme.schemeName}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            <InfoRow label="Booking Amount" value={scheme.bookingAmount == null ? "—" : formatCurrency(scheme.bookingAmount)} />
            <InfoRow label="Scheme Benefit" value={`${BENEFIT_LABEL[scheme.schemeBenefit] ?? scheme.schemeBenefit}${scheme.benefitDetails ? ` · ${scheme.benefitDetails}` : ""}`} />
            <InfoRow label="Scheme Value (Without GST)" value={formatCurrency(scheme.schemeValueWithoutGST)} />
            <InfoRow label="Scheme Value (With GST)" value={formatCurrency(scheme.schemeValueWithGST)} />
            <InfoRow label="Scheme Period" value={scheme.isPerpetual ? "Perpetual" : `${formatDate(scheme.startDate)} – ${formatDate(scheme.endDate)}`} />
            <InfoRow label="Last Booking Date" value={scheme.isPerpetual ? "—" : formatDate(scheme.bookingLastDate)} />
            <InfoRow label="State(s)" value={scheme.states.length ? scheme.states.join(", ") : "—"} />
            <InfoRow label="Multiple Schemes per Dealer" value={scheme.allowMultipleSchemes ? "Allowed" : "Not allowed"} />
            {scheme.otherBenefitDetails && <InfoRow label="Other Benefit Details" value={scheme.otherBenefitDetails} />}
            <InfoRow label="Scheme Document" value={scheme.documentUrl ? "Attached" : "Not attached"} />
          </div>
          {scheme.installments.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Installment Rules</p>
              <div className="overflow-auto rounded-md border">
                <Table>
                  <TableHeader><TableRow><TableHead className="w-12">#</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Value</TableHead><TableHead className="text-right">Days after Billing</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {scheme.installments.map((r) => (
                      <TableRow key={r.installmentNumber}>
                        <TableCell>{r.installmentNumber}</TableCell>
                        <TableCell>{CALC_LABEL[r.calculationType] ?? r.calculationType}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.calculationType === "PERCENTAGE" ? `${r.value}%` : formatCurrency(r.value)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.daysAfterBillingDate}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1 last:border-0 sm:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

/* --------------------------------- Document + Share --------------------------------- */

/** MIME → extension for the accepted upload types, so a shared file arrives with a usable name. */
const DOC_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/**
 * Decode the stored `documentUrl`. Scheme Master uploads the document with `FileReader.readAsDataURL`, so the
 * value is a base64 `data:` URL rather than a link. Browsers refuse top-level navigation to `data:` URLs, so
 * viewing it means handing the same bytes to the page as a Blob — no new storage mechanism, no download step.
 */
function decodeDocument(documentUrl: string): { blob: Blob; mime: string } | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(documentUrl);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  try {
    if (m[2]) {
      const bin = atob(m[3]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { blob: new Blob([bytes], { type: mime }), mime };
    }
    return { blob: new Blob([decodeURIComponent(m[3])], { type: mime }), mime };
  } catch {
    return null;
  }
}

const safeName = (s: string) => s.replace(/[^\w\-. ]+/g, "_").trim() || "scheme";

/** The scheme document as a shareable File, when the stored value is a data: URL we can decode. */
export function schemeDocumentFile(scheme: RunningScheme): File | null {
  if (typeof File === "undefined" || !scheme.documentUrl?.startsWith("data:")) return null;
  const decoded = decodeDocument(scheme.documentUrl);
  if (!decoded) return null;
  const ext = DOC_EXT[decoded.mime];
  return new File([decoded.blob], `${safeName(scheme.schemeName)}${ext ? `.${ext}` : ""}`, { type: decoded.mime });
}

/** Plain-text scheme summary — it only restates what the Info panel already shows. */
export function schemeShareText(scheme: RunningScheme): string {
  const out = [
    scheme.schemeName,
    `Period: ${scheme.isPerpetual ? "Perpetual" : `${formatDate(scheme.startDate)} – ${formatDate(scheme.endDate)}`}`,
  ];
  if (!scheme.isPerpetual) out.push(`Last Booking Date: ${formatDate(scheme.bookingLastDate)}`);
  out.push(
    `Benefit: ${BENEFIT_LABEL[scheme.schemeBenefit] ?? scheme.schemeBenefit}${scheme.benefitDetails ? ` · ${scheme.benefitDetails}` : ""}`,
    `Scheme Value (Without GST): ${formatCurrency(scheme.schemeValueWithoutGST)}`,
    `Scheme Value (With GST): ${formatCurrency(scheme.schemeValueWithGST)}`,
  );
  if (scheme.bookingAmount != null) out.push(`Booking Amount: ${formatCurrency(scheme.bookingAmount)}`);
  if (scheme.installments.length > 0) out.push(`Installments: ${scheme.installments.length}`);
  if (scheme.otherBenefitDetails) out.push(`Notes: ${scheme.otherBenefitDetails}`);
  return out.join("\n");
}

/** In-browser document viewer. The bytes are turned into a Blob URL for the lifetime of the dialog. */
export function SchemeDocumentDialog({ scheme, onClose }: { scheme: RunningScheme; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const raw = scheme.documentUrl;
    if (!raw) { setFailed(true); return; }
    // A plain link (should it ever be stored as one) is already viewable as-is.
    if (!raw.startsWith("data:")) { setUrl(raw); return; }
    const decoded = decodeDocument(raw);
    if (!decoded) { setFailed(true); return; }
    const objectUrl = URL.createObjectURL(decoded.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [scheme.documentUrl]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader><DialogTitle>Scheme Document — {scheme.schemeName}</DialogTitle></DialogHeader>
        {failed || !url ? (
          <p className="text-sm text-muted-foreground">{failed ? "This scheme has no document that can be displayed." : "Preparing the document…"}</p>
        ) : (
          <>
            <iframe src={url} title={`${scheme.schemeName} document`} className="h-[70vh] w-full rounded-md border bg-muted/20" />
            <p className="text-xs text-muted-foreground">If the preview stays blank, the file type cannot be displayed inline — open it in a new tab instead.</p>
          </>
        )}
        <DialogFooter>
          {url && <Button variant="outline" asChild><a href={url} target="_blank" rel="noreferrer"><FileText className="h-4 w-4" /> Open in new tab</a></Button>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Share fallback for browsers without the Web Share API (most desktops). Same convention the Follow-up share
 * sheet uses: show the exact message, then open WhatsApp with it (`wa.me` deep link, contact chosen in
 * WhatsApp) or copy it. A deep link cannot carry a file attachment, so this shares the information and points
 * at the document rather than pretending the file went with it.
 */
export function SchemeShareDialog({ scheme, onClose }: { scheme: RunningScheme; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = schemeShareText(scheme);
  const link = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Share scheme — {scheme.schemeName}</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <Label>Message</Label>
          <Textarea readOnly value={text} rows={10} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <p className="text-xs text-muted-foreground">
            Opens WhatsApp with this message ready to send — nothing is sent automatically.
            {scheme.documentUrl ? " A browser share link cannot carry the document; use View Document to open it and attach it yourself." : ""}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={copy}><Copy className="h-4 w-4" /> {copied ? "Copied" : "Copy summary"}</Button>
          <Button asChild><a href={link} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" /> Open WhatsApp</a></Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------- Partial submission --------------------------------- */

/** Submit with incomplete dealers — nothing is discarded silently, and nothing is submitted until answered. */
function IncompleteSubmitDialog({ scheme, complete, incomplete, pending, onCancel, onConfirm }: {
  scheme: RunningScheme;
  complete: DealerRow[];
  incomplete: DealerRow[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Some dealers have incomplete information.</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">{scheme.schemeName}</p>
          <div className="space-y-1.5 rounded-md border p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Incomplete — will stay in Draft</p>
            <ul className="space-y-1">
              {incomplete.map((r) => (
                <li key={r.dealerId} className="flex justify-between gap-4"><span className="font-medium">{r.dealerName}</span><span className="text-muted-foreground">Conversion Date missing</span></li>
              ))}
            </ul>
          </div>
          <div className="space-y-1.5 rounded-md border p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Complete — will be submitted ({complete.length})</p>
            {complete.length === 0 ? (
              <p className="text-muted-foreground">No dealer is ready to submit yet.</p>
            ) : (
              <ul className="space-y-1">
                {complete.map((r) => (
                  <li key={r.dealerId} className="flex justify-between gap-4"><span className="font-medium">{r.dealerName}</span><span className="text-muted-foreground">{formatDate(r.date)}</span></li>
                ))}
              </ul>
            )}
          </div>
          <p>Do you want to submit the completed dealers and keep the incomplete dealers in Draft?</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>No, go back</Button>
          <Button disabled={pending || complete.length === 0} onClick={onConfirm}><Send className="h-4 w-4" /> Yes, submit {complete.length} dealer{complete.length === 1 ? "" : "s"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
