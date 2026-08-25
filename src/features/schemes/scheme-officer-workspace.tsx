"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Eye, Save, Send, Pencil } from "lucide-react";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PlanStateBadge, SchemeStatusBadge, type SchemePlan } from "./scheme-detail-dialog";
import { EnrolledSchemesView } from "./scheme-enrolled-view";

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
  const [tab, setTab] = useState<"running" | "mine" | "enrolled">("running");
  const [planningId, setPlanningId] = useState<string | null>(null);

  if (planningId) return <SchemePlanningView schemeId={planningId} onBack={() => setPlanningId(null)} />;

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: "Planning" }, { label: "Scheme Planning" }]} title="Scheme Planning" subtitle="Plan your dealers into running schemes and submit for approval." />
      <div className="flex gap-2">
        <PillButton active={tab === "running"} onClick={() => setTab("running")}>Running Schemes</PillButton>
        <PillButton active={tab === "mine"} onClick={() => setTab("mine")}>My Schemes</PillButton>
        <PillButton active={tab === "enrolled"} onClick={() => setTab("enrolled")}>Enrolled Scheme</PillButton>
      </div>
      {tab === "running" ? <RunningSchemesTab onView={setPlanningId} /> : tab === "mine" ? <MySchemesTab onOpen={setPlanningId} /> : <EnrolledSchemesView />}
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

/* --------------------------------- My Schemes --------------------------------- */

function MySchemesTab({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient();
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

  const [convert, setConvert] = useState<SchemePlan | null>(null);
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (groups.length === 0) return <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">You haven&apos;t planned any schemes yet.</div>;

  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const editable = g.plans.some((p) => p.planStatus === "DRAFT" || p.planStatus === "RETURNED");
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
                      <TableHead>Conversion Date</TableHead>
                      <TableHead className="text-right">Schemes</TableHead>
                      <TableHead className="text-right">Total Amount</TableHead>
                      <TableHead>Planning Date</TableHead>
                      <TableHead>Plan Status</TableHead>
                      <TableHead>Scheme Status</TableHead>
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
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        );
      })}
      {convert && <ConversionModal plan={convert} onClose={() => setConvert(null)} onSaved={() => { setConvert(null); qc.invalidateQueries({ queryKey: ["scheme-plans"] }); }} />}
    </div>
  );
}

const dateTime = (s: string) => new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/** SO conversion entry: set Scheme Status and (when Converted) record conversion details. */
function ConversionModal({ plan, onClose, onSaved }: { plan: SchemePlan; onClose: () => void; onSaved: () => void }) {
  const [schemeStatus, setSchemeStatus] = useState(plan.schemeStatus === "PENDING" ? "CONVERTED" : plan.schemeStatus);
  const [conversionDate, setConversionDate] = useState(toDateInput(plan.conversionDate));
  const [booking, setBooking] = useState(plan.soBookingStatus ?? "RECEIVED");
  const [bookingAmount, setBookingAmount] = useState(plan.soBookingAmount != null ? String(plan.soBookingAmount) : "");
  const [doc, setDoc] = useState(plan.soDocumentStatus ?? "IN_TRANSIT");
  const [billingDate, setBillingDate] = useState(toDateInput(plan.billingDate));
  const [error, setError] = useState<string | null>(null);
  const converting = schemeStatus === "CONVERTED";

  const save = useMutation({
    mutationFn: () => api.patch(`/api/scheme-plans/${plan.id}/conversion`, {
      schemeStatus,
      conversionDate: converting ? (conversionDate || null) : null,
      soBookingStatus: converting ? booking : null,
      soBookingAmount: converting && booking === "PARTIAL" ? Number(bookingAmount) : (converting && bookingAmount ? Number(bookingAmount) : null),
      soDocumentStatus: converting ? doc : null,
      billingDate: converting ? (billingDate || null) : null,
    }),
    onSuccess: onSaved,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{plan.schemeName} — {plan.dealerName}</DialogTitle></DialogHeader>
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
              <div className="space-y-1.5"><Label>Document Status</Label><NativeSelect value={doc} onChange={(e) => setDoc(e.target.value)} options={[{ value: "IN_TRANSIT", label: "In Transit" }, { value: "RECEIVED", label: "Received" }, { value: "NOT_RECEIVED", label: "Not Received" }]} /></div>
              <div className="space-y-1.5"><Label>Billing Date</Label><Input type="date" value={billingDate} onChange={(e) => setBillingDate(e.target.value)} /></div>
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground">No approval is required after this — these values are visible to your RM and Admin, who verifies them.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending || (converting && booking === "PARTIAL" && !bookingAmount)} onClick={() => { setError(null); save.mutate(); }}>{save.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
