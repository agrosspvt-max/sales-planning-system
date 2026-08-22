"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Eye, Save, Send } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PlanStatusBadge, EnrollStatusBadge, type SchemePlan } from "./scheme-detail-dialog";

const BENEFIT_LABEL: Record<string, string> = { DOMESTIC_TOUR: "Domestic Tour", DOMESTIC_COUPLE_TOUR: "Domestic Couple Tour", FOREIGN_TOUR: "Foreign Tour", CREDIT_NOTE: "Credit Note", OTHER: "Other" };
const CALC_LABEL: Record<string, string> = { PERCENTAGE: "Percentage", FIXED_AMOUNT: "Fixed Amount" };
const EDITABLE = new Set(["DRAFT", "RETURNED"]);
const toDateInput = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : "");

interface RunningScheme {
  id: string; schemeName: string; states: string[]; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null;
  schemeBenefit: string; benefitDetails: string | null; schemeValueWithoutGST: number; schemeValueWithGST: number; documentUrl: string | null;
}

/** Sales Officer scheme planning: Running Schemes + My Schemes tabs, and the per-scheme planning page. */
export function SchemeOfficerWorkspace() {
  const [tab, setTab] = useState<"running" | "mine">("running");
  const [planningId, setPlanningId] = useState<string | null>(null);

  if (planningId) return <SchemePlanningView schemeId={planningId} onBack={() => setPlanningId(null)} />;

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: "Planning" }, { label: "Scheme Planning" }]} title="Scheme Planning" subtitle="Plan your dealers into running schemes and submit for approval." />
      <div className="flex gap-2">
        <PillButton active={tab === "running"} onClick={() => setTab("running")}>Running Schemes</PillButton>
        <PillButton active={tab === "mine"} onClick={() => setTab("mine")}>My Schemes</PillButton>
      </div>
      {tab === "running" ? <RunningSchemesTab onView={setPlanningId} /> : <MySchemesTab onOpen={setPlanningId} />}
    </div>
  );
}

function PillButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium transition-colors", active ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}>
      {children}
    </button>
  );
}

/* --------------------------------- Running Schemes --------------------------------- */

function RunningSchemesTab({ onView }: { onView: (id: string) => void }) {
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

/* --------------------------------- My Schemes --------------------------------- */

function MySchemesTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, isLoading } = useQuery<SchemePlan[]>({ queryKey: ["scheme-plans", "mine"], queryFn: () => api.get("/api/scheme-plans") });
  const groups = useMemo(() => {
    const map = new Map<string, { schemeId: string; schemeName: string; plans: SchemePlan[] }>();
    for (const p of data ?? []) {
      const g = map.get(p.schemeId) ?? { schemeId: p.schemeId, schemeName: p.schemeName, plans: [] };
      g.plans.push(p);
      map.set(p.schemeId, g);
    }
    return [...map.values()];
  }, [data]);

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (groups.length === 0) return <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">You haven&apos;t planned any schemes yet.</div>;

  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const editable = g.plans.some((p) => EDITABLE.has(p.planningStatus));
        return (
          <Card key={g.schemeId}>
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
              <CardTitle className="text-base">{g.schemeName} <span className="ml-2 text-sm font-normal text-muted-foreground">{g.plans.length} dealer{g.plans.length === 1 ? "" : "s"}</span></CardTitle>
              <Button size="sm" variant="outline" onClick={() => onOpen(g.schemeId)}>{editable ? "Continue Planning" : "View"}</Button>
            </CardHeader>
            <CardContent>
              <div className="overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dealer</TableHead>
                      <TableHead>Expected Billing Date</TableHead>
                      <TableHead>Planning Status</TableHead>
                      <TableHead>Enrollment Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.plans.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.dealerName}</TableCell>
                        <TableCell>{p.expectedBillingDate ? formatDate(p.expectedBillingDate) : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell><PlanStatusBadge status={p.planningStatus} /></TableCell>
                        <TableCell><EnrollStatusBadge status={p.enrollmentStatus} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/* --------------------------------- Planning page --------------------------------- */

interface PlanningCtx {
  scheme: {
    id: string; schemeName: string; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null;
    bookingAmount: number | null; schemeValueWithoutGST: number; schemeValueWithGST: number; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
    documentUrl: string | null; installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
  };
  dealers: { id: string; name: string; territory: string | null }[];
  existing: { dealerId: string; expectedBillingDate: string | null; planningStatus: string; enrollmentStatus: string }[];
}

function SchemePlanningView({ schemeId, onBack }: { schemeId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<PlanningCtx>({ queryKey: ["scheme-planning", schemeId], queryFn: () => api.get(`/api/schemes/${schemeId}/planning`) });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dates, setDates] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Load an existing draft (or submitted rows) so re-opening a scheme restores dealers + dates.
  const existingByDealer = useMemo(() => new Map((data?.existing ?? []).map((e) => [e.dealerId, e])), [data]);
  useEffect(() => {
    if (!data) return;
    setSelected(new Set(data.existing.map((e) => e.dealerId)));
    setDates(Object.fromEntries(data.existing.map((e) => [e.dealerId, toDateInput(e.expectedBillingDate)])));
  }, [data]);

  const isLocked = (dealerId: string) => {
    const e = existingByDealer.get(dealerId);
    return !!e && !EDITABLE.has(e.planningStatus);
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
  const buildPayload = () => ({ schemeId, dealers: editableSelected().map((id) => ({ dealerId: id, expectedBillingDate: dates[id] || null })) });

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["scheme-planning", schemeId] }); qc.invalidateQueries({ queryKey: ["scheme-plans"] }); };
  const saveDraft = useMutation({ mutationFn: () => api.post("/api/scheme-plans/save-draft", buildPayload()), onSuccess: invalidate, onError: (e) => setError((e as Error).message) });
  const submit = useMutation({ mutationFn: () => api.post("/api/scheme-plans/submit-draft", buildPayload()), onSuccess: () => { invalidate(); onBack(); }, onError: (e) => setError((e as Error).message) });

  const selectedDealers = (data?.dealers ?? []).filter((d) => selected.has(d.id));
  const missingDate = editableSelected().some((id) => !dates[id]);

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: "Planning" }, { label: "Scheme Planning" }, { label: scheme?.schemeName ?? "…" }]} title={scheme?.schemeName ?? "Scheme"} subtitle="Select dealers and set expected billing dates." actions={<Button variant="outline" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</Button>} />

      {isLoading || !scheme ? (
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
                <p className="text-sm text-muted-foreground">No dealers are assigned to you.</p>
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
                            <TableCell>{ex ? <PlanStatusBadge status={ex.planningStatus} /> : <span className="text-muted-foreground">—</span>}</TableCell>
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
                    <TableHeader><TableRow><TableHead>Dealer Name</TableHead><TableHead>Expected Billing Date</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {selectedDealers.map((d) => {
                        const locked = isLocked(d.id);
                        const ex = existingByDealer.get(d.id);
                        return (
                          <TableRow key={d.id}>
                            <TableCell className="font-medium">{d.name}</TableCell>
                            <TableCell>
                              <Input type="date" className="w-44" min={minDate} max={maxDate} disabled={locked} value={dates[d.id] ?? ""} onChange={(e) => setDates((prev) => ({ ...prev, [d.id]: e.target.value }))} />
                            </TableCell>
                            <TableCell>{ex ? <PlanStatusBadge status={ex.planningStatus} /> : <Badge variant="muted">New</Badge>}</TableCell>
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
