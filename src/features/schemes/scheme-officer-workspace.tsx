"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Eye, Save, Send } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { L } from "@/features/labels/label-ui";
import { type LabelKey } from "@/features/labels/labels";
import { PlanStateBadge } from "./scheme-detail-dialog";
import { SchemeCreatePlanWorkspace } from "./scheme-create-plan";

const BENEFIT_LABEL: Record<string, string> = { DOMESTIC_TOUR: "Domestic Tour", DOMESTIC_COUPLE_TOUR: "Domestic Couple Tour", FOREIGN_TOUR: "Foreign Tour", CREDIT_NOTE: "Credit Note", OTHER: "Other" };
const CALC_LABEL: Record<string, string> = { PERCENTAGE: "Percentage", FIXED_AMOUNT: "Fixed Amount" };
const EDITABLE = new Set(["DRAFT", "RETURNED"]);
export const toDateInput = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : "");

interface RunningScheme {
  id: string; schemeName: string; states: string[]; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null;
  schemeBenefit: string; benefitDetails: string | null; schemeValueWithoutGST: number; schemeValueWithGST: number; documentUrl: string | null;
}

/**
 * Sales Officer — the CREATE PLAN side of Scheme Planning (/planning/scheme). Every running scheme the
 * officer may plan into is one collapsible row that expands to its planned dealers; dealers are added one at
 * a time through "Add Dealer", and each scheme is saved or submitted on its own. Looking at schemes already
 * planned lives on the View Plan route (/planning/scheme/plans), mirroring Sales and Recovery Planning.
 */
export function SchemeOfficerWorkspace() {
  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Scheme Planning" }]}
        title="Scheme Planning"
        subtitle="Plan your dealers into running schemes and submit for approval."
      />

      {/* Level 1 — Create New Plan | View Plans | Follow-up Plans */}
      <SchemePlanModeLinks mode="create" />

      <SchemeCreatePlanWorkspace />
    </div>
  );
}

/**
 * [Create New Plan | View Plans | Follow-up Plans] toggle rendered as links — each option is its own
 * route, matching the Sales Planning and Recovery Planning modules. Follow-up Plans (Requirement 3) is an
 * ADDITION alongside the existing two: nothing inside View Plans is renamed, moved or merged.
 */
export type SchemePlanMode = "create" | "view" | "followup";

const MODE_LINKS: { mode: SchemePlanMode; href: string; labelKey: LabelKey }[] = [
  { mode: "create", href: "/planning/scheme", labelKey: "scheme_planning.nav.create_plan" },
  { mode: "view", href: "/planning/scheme/plans", labelKey: "scheme_planning.nav.view_plan" },
  { mode: "followup", href: "/planning/scheme/follow-up", labelKey: "scheme_planning.nav.follow_up" },
];

export function SchemePlanModeLinks({ mode }: { mode: SchemePlanMode }) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
      {MODE_LINKS.map((m) => (
        <Link
          key={m.mode}
          href={m.href}
          className={`rounded px-3 py-1.5 font-medium ${mode === m.mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          <L k={m.labelKey} />
        </Link>
      ))}
    </div>
  );
}

/* --------------------------------- Running Schemes --------------------------------- */

/**
 * The flat running-schemes list whose row action was "View Scheme". NOW UNREFERENCED: both call sites (the SO
 * Create Plan page and the RM Running Schemes tab) render `SchemeCreatePlanWorkspace` instead, where the row
 * action is Add Dealer and the scheme information moved to the row's ⋮ menu. Kept rather than deleted because
 * removing it is not required by the redesign — flagged so it is not mistaken for live UI.
 */
export function RunningSchemesTab({ onView }: { onView: (id: string) => void }) {
  const { data, isLoading } = useQuery<RunningScheme[]>({ queryKey: ["running-schemes"], queryFn: () => api.get("/api/schemes/running") });
  return (
    <div className="overflow-auto rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scheme Name</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Scheme Period</TableHead>
            <TableHead>Benefit</TableHead>
            <TableHead className="text-right">Scheme Value</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
          ) : (data?.length ?? 0) === 0 ? (
            <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No running schemes for your State.</TableCell></TableRow>
          ) : (
            data!.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.schemeName}{s.documentUrl && <a href={s.documentUrl} target="_blank" rel="noreferrer" className="ml-2 inline-block text-primary" title="Scheme document"><FileText className="h-4 w-4" /></a>}</TableCell>
                <TableCell>{s.states.join(", ")}</TableCell>
                <TableCell>{s.isPerpetual ? "Perpetual" : `${formatDate(s.startDate)} – ${formatDate(s.endDate)}`}</TableCell>
                <TableCell>{BENEFIT_LABEL[s.schemeBenefit] ?? s.schemeBenefit}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(s.schemeValueWithGST)}</TableCell>
                <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => onView(s.id)}><Eye className="h-4 w-4" /> View Scheme</Button></TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/* --------------------------------- Planning page --------------------------------- */

interface PlanningCtx {
  scheme: {
    id: string; schemeName: string; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null;
    bookingAmount: number | null; schemeValueWithoutGST: number; schemeValueWithGST: number; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
    allowMultipleSchemes: boolean; documentUrl: string | null; installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
  };
  dealers: { id: string; name: string; territory: string | null }[];
  existing: { dealerId: string; expectedBillingDate: string | null; planningStatus: string; enrollmentStatus: string; planStatus: string; numberOfSchemes: number }[];
}

export function SchemePlanningView({ schemeId, onBack, enableRmScope = false }: { schemeId: string; onBack: () => void; enableRmScope?: boolean }) {
  const qc = useQueryClient();

  // RM "My Dealers" (self) vs "My Team" (a chosen Sales Officer's dealers). Sales Officers never see this.
  const [scope, setScope] = useState<"self" | "team">("self");
  const [officerId, setOfficerId] = useState("");
  const teamMode = enableRmScope && scope === "team";
  const targetOfficer = teamMode ? officerId : "";
  const { data: officers } = useQuery<{ id: string; name: string }[]>({ queryKey: ["scheme-team-officers"], queryFn: () => api.get("/api/schemes/team-officers"), enabled: enableRmScope });

  const contextReady = !teamMode || !!officerId; // wait for an SO before loading team dealers
  const { data, isLoading } = useQuery<PlanningCtx>({
    queryKey: ["scheme-planning", schemeId, targetOfficer || "self"],
    queryFn: () => api.get(`/api/schemes/${schemeId}/planning${targetOfficer ? `?officerId=${encodeURIComponent(targetOfficer)}` : ""}`),
    enabled: contextReady,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dates, setDates] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const allowMulti = !!data?.scheme.allowMultipleSchemes;

  // Load an existing draft (or submitted rows) so re-opening a scheme restores dealers + dates.
  const existingByDealer = useMemo(() => new Map((data?.existing ?? []).map((e) => [e.dealerId, e])), [data]);
  useEffect(() => {
    if (!data) return;
    setSelected(new Set(data.existing.map((e) => e.dealerId)));
    setDates(Object.fromEntries(data.existing.map((e) => [e.dealerId, toDateInput(e.expectedBillingDate)])));
    setCounts(Object.fromEntries(data.existing.map((e) => [e.dealerId, e.numberOfSchemes || 1])));
  }, [data]);

  const isLocked = (dealerId: string) => {
    const e = existingByDealer.get(dealerId);
    return !!e && !EDITABLE.has(e.planStatus);
  };
  const toggle = (dealerId: string) => {
    if (isLocked(dealerId)) return;
    setSelected((prev) => { const next = new Set(prev); if (next.has(dealerId)) next.delete(dealerId); else next.add(dealerId); return next; });
  };

  const scheme = data?.scheme;
  const minDate = scheme?.startDate ? toDateInput(scheme.startDate) : undefined;
  const maxDate = scheme && !scheme.isPerpetual && scheme.endDate ? toDateInput(scheme.endDate) : undefined;

  // Payload = only editable, selected dealers (locked rows are managed by the RM/Admin, never touched here).
  const editableSelected = () => [...selected].filter((id) => !isLocked(id));
  const buildPayload = () => ({ schemeId, officerId: teamMode ? officerId : undefined, dealers: editableSelected().map((id) => ({ dealerId: id, expectedBillingDate: dates[id] || null, numberOfSchemes: allowMulti ? (counts[id] || 1) : 1 })) });

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["scheme-planning", schemeId] }); qc.invalidateQueries({ queryKey: ["scheme-plans"] }); };
  const saveDraft = useMutation({ mutationFn: () => api.post("/api/scheme-plans/save-draft", buildPayload()), onSuccess: invalidate, onError: (e) => setError((e as Error).message) });
  const submit = useMutation({ mutationFn: () => api.post("/api/scheme-plans/submit-draft", buildPayload()), onSuccess: () => { invalidate(); onBack(); }, onError: (e) => setError((e as Error).message) });

  const selectedDealers = (data?.dealers ?? []).filter((d) => selected.has(d.id));
  const missingDate = editableSelected().some((id) => !dates[id]);

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: "Planning" }, { label: "Scheme Planning" }, { label: scheme?.schemeName ?? "…" }]} title={scheme?.schemeName ?? "Scheme"} subtitle="Select dealers and set expected billing dates." actions={<Button variant="outline" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</Button>} />

      {enableRmScope && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Dealer Scope</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label>Dealer Scope</Label>
                <NativeSelect className="w-44" value={scope} onChange={(e) => { setScope(e.target.value as "self" | "team"); setOfficerId(""); }} options={[{ value: "self", label: "My Dealers" }, { value: "team", label: "My Team" }]} />
              </div>
              {scope === "team" && (
                <div className="space-y-1.5">
                  <Label>Sales Officer</Label>
                  <NativeSelect className="w-56" placeholder="Select a Sales Officer…" value={officerId} onChange={(e) => setOfficerId(e.target.value)} options={(officers ?? []).map((o) => ({ value: o.id, label: o.name }))} />
                </div>
              )}
            </div>
            {scope === "team" && (officers?.length ?? 0) === 0 && <p className="mt-2 text-xs text-muted-foreground">No Sales Officers on your team yet.</p>}
          </CardContent>
        </Card>
      )}

      {teamMode && !officerId ? (
        <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">Select a Sales Officer to plan their dealers.</div>
      ) : isLoading || !scheme ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Scheme Details</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                <Info label="Booking Amount" value={scheme.bookingAmount == null ? "—" : formatCurrency(scheme.bookingAmount)} />
                <Info label="Scheme Benefit" value={`${BENEFIT_LABEL[scheme.schemeBenefit] ?? scheme.schemeBenefit}${scheme.benefitDetails ? ` · ${scheme.benefitDetails}` : ""}`} />
                <Info label="Scheme Value (Without GST)" value={formatCurrency(scheme.schemeValueWithoutGST)} />
                <Info label="Scheme Value (With GST)" value={formatCurrency(scheme.schemeValueWithGST)} />
                <Info label="Scheme Period" value={scheme.isPerpetual ? "Perpetual" : `${formatDate(scheme.startDate)} – ${formatDate(scheme.endDate)}`} />
                <Info label="Last Booking Date" value={scheme.isPerpetual ? "—" : formatDate(scheme.bookingLastDate)} />
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
              {scheme.documentUrl && <a href={scheme.documentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><FileText className="h-4 w-4" /> Download Scheme Document</a>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Select Dealers</CardTitle></CardHeader>
            <CardContent>
              {data!.dealers.length === 0 ? (
                <p className="text-sm text-muted-foreground">{teamMode ? "No dealers are assigned to the selected Sales Officer." : "No dealers are assigned to you."}</p>
              ) : (
                <div className="overflow-auto rounded-md border">
                  <Table>
                    <TableHeader><TableRow><TableHead className="w-12"></TableHead><TableHead>Dealer Name</TableHead><TableHead>Territory</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {data!.dealers.map((d) => {
                        const ex = existingByDealer.get(d.id);
                        const locked = isLocked(d.id);
                        return (
                          <TableRow key={d.id} className={cn(!locked && "cursor-pointer hover:bg-accent/40")} onClick={() => toggle(d.id)}>
                            <TableCell><input type="checkbox" checked={selected.has(d.id)} disabled={locked} onChange={() => toggle(d.id)} onClick={(e) => e.stopPropagation()} /></TableCell>
                            <TableCell className="font-medium">{d.name}</TableCell>
                            <TableCell>{d.territory ?? <span className="text-muted-foreground">—</span>}</TableCell>
                            <TableCell>{ex ? <PlanStateBadge status={ex.planStatus} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {selectedDealers.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Planning</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-auto rounded-md border">
                  <Table>
                    <TableHeader><TableRow><TableHead>Dealer Name</TableHead><TableHead>Conversion Date</TableHead>{allowMulti && <><TableHead>Number of Schemes</TableHead><TableHead className="text-right">Total Amount</TableHead></>}<TableHead>Status</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {selectedDealers.map((d) => {
                        const locked = isLocked(d.id);
                        const ex = existingByDealer.get(d.id);
                        const n = allowMulti ? (counts[d.id] || 1) : 1;
                        return (
                          <TableRow key={d.id}>
                            <TableCell className="font-medium">{d.name}</TableCell>
                            <TableCell>
                              <Input type="date" className="w-44" min={minDate} max={maxDate} disabled={locked} value={dates[d.id] ?? ""} onChange={(e) => setDates((prev) => ({ ...prev, [d.id]: e.target.value }))} />
                            </TableCell>
                            {allowMulti && (
                              <>
                                <TableCell>
                                  <NativeSelect className="w-20" disabled={locked} value={String(n)} onChange={(e) => setCounts((prev) => ({ ...prev, [d.id]: Number(e.target.value) }))} options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{formatCurrency((scheme?.schemeValueWithGST ?? 0) * n)}</TableCell>
                              </>
                            )}
                            <TableCell>{ex ? <PlanStateBadge status={ex.planStatus} /> : <Badge variant="muted">New</Badge>}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={saveDraft.isPending} onClick={() => { setError(null); saveDraft.mutate(); }}><Save className="h-4 w-4" /> {saveDraft.isPending ? "Saving…" : "Save Draft"}</Button>
            <Button disabled={submit.isPending || editableSelected().length === 0 || missingDate} onClick={() => { setError(null); submit.mutate(); }}><Send className="h-4 w-4" /> {submit.isPending ? "Submitting…" : "Submit"}</Button>
          </div>
        </>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1 last:border-0 sm:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
