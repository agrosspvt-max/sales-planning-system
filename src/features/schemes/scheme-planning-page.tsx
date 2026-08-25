"use client";

import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { CornerUpLeft, Send, Eye, ShieldCheck, ChevronRight, ChevronLeft, ChevronDown, Trash2, AlertTriangle } from "lucide-react";
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
import { PlanStateBadge, SchemeStatusBadge, SchemePlanDialog, PLAN_STATUS_LABEL, MarkedValue, conversionDateCell, bookingCell, documentCell, billingDateCell, type SchemePlan } from "./scheme-detail-dialog";
import { schemeTable, verifyTint } from "./scheme-table-theme";
import { SchemeOfficerWorkspace, RunningSchemesTab, SchemePlanningView } from "./scheme-officer-workspace";
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
 * Scheme Planning entry — role-aware. Sales Officers use the field-sales workflow (Running Schemes /
 * My Schemes with drafts); Regional Managers approve/reject/return their team's plans (planning approval
 * only); Super Admin verifies enrollment documents and enrolls dealers.
 */
export function SchemePlanningPage({ role, userId }: { role: Role; userId: string }) {
  if (role === Role.SALES_OFFICER) return <SchemeOfficerWorkspace />;
  return <SchemeReviewWorkspace role={role} userId={userId} />;
}

interface SchemeGroup { schemeId: string; schemeName: string; plans: SchemePlan[] }
type ReasonPrompt = { title: string; confirmLabel: string; require: boolean; run: (remarks: string) => void };

/**
 * RM/Admin review — the SAME grouped, collapsible SCHEME → DEALERS structure for both roles. Only the
 * available actions differ by role: RM approves/returns/rejects planning (incl. Return Entire Scheme);
 * Super Admin verifies enrollment documents. Row-level DealerSchemePlan statuses are never changed by the
 * grouping itself; every action reuses the existing endpoints.
 */
function SchemeReviewWorkspace({ role, userId }: { role: Role; userId: string }) {
  const qc = useQueryClient();
  const isManager = role === Role.REGIONAL_MANAGER;
  const isAdmin = role === Role.SUPER_ADMIN;

  const { data: rows, isLoading } = useQuery<SchemePlan[]>({ queryKey: ["scheme-plans", "all"], queryFn: () => api.get("/api/scheme-plans") });
  const [detail, setDetail] = useState<SchemePlan | null>(null);
  const [verify, setVerify] = useState<SchemePlan | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // collapsed by default
  const [reason, setReason] = useState<ReasonPrompt | null>(null);
  // RM gets a "Running Schemes" tab to CREATE plans (skips RM approval); Admin has no create.
  const [view, setView] = useState<"review" | "running" | "enrolled">("review");
  const [runId, setRunId] = useState<string | null>(null); // scheme being planned in the Running tab
  const [verifyCols, setVerifyCols] = useState(true); // horizontal collapse of the 4 verification columns (UI-only, expanded by default)
  const [deleteTarget, setDeleteTarget] = useState<SchemeGroup | null>(null); // Super-Admin permanent-delete flow
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
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Scheme Planning" }]}
        title="Scheme Planning"
        subtitle={isManager ? "Approve, reject or return your team's scheme plans." : "Verify enrollment documents and enroll dealers."}
        actions={undefined}
      />

      <div className="flex gap-2">
        <button type="button" onClick={() => setView("review")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", view === "review" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}>Review</button>
        {isManager && <button type="button" onClick={() => { setView("running"); setRunId(null); }} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", view === "running" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}>Running Schemes</button>}
        <button type="button" onClick={() => setView("enrolled")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", view === "enrolled" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}>Enrolled Scheme</button>
      </div>

      {view === "enrolled" ? <EnrolledSchemesView /> : view === "running" ? (
        runId ? <SchemePlanningView schemeId={runId} enableRmScope onBack={() => setRunId(null)} /> : <RunningSchemesTab onView={setRunId} />
      ) : (
      <div className={schemeTable.outer}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Scheme</TableHead>
              <TableHead>Dealers</TableHead>
              <TableHead>Sales Officer(s)</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Plan Status</TableHead>
              <TableHead>Scheme Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
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
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setDeleteTarget(g)}
                            title="Permanently delete this entire scheme"
                          >
                            <Trash2 className="h-4 w-4" /> Delete Scheme
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
                                  <TableHead>Dealer</TableHead>
                                  <TableHead>Sales Officer</TableHead>
                                  <TableHead>State</TableHead>
                                  <TableHead>Planned Conversion</TableHead>
                                  <TableHead>Plan Status</TableHead>
                                  <TableHead>Scheme Status</TableHead>
                                  <TableHead className="w-8 border-l p-0 text-center">
                                    <button type="button" title={verifyCols ? "Hide verification details" : "Show verification details"} aria-label={verifyCols ? "Hide verification details" : "Show verification details"} onClick={() => setVerifyCols((v) => !v)} className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                                      {verifyCols ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                    </button>
                                  </TableHead>
                                  {verifyCols && (
                                    <>
                                      <TableHead className={verifyTint.conversion.head}>Conversion Date</TableHead>
                                      <TableHead className={verifyTint.booking.head}>Booking Amount</TableHead>
                                      <TableHead className={verifyTint.document.head}>Document Status</TableHead>
                                      <TableHead className={verifyTint.billing.head}>Billing Date</TableHead>
                                    </>
                                  )}
                                  <TableHead className="border-l text-right">Actions</TableHead>
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
      {deleteTarget && <DeleteSchemeDialog group={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={() => { setDeleteTarget(null); invalidate(); }} />}
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

/* --------------------------- Permanent scheme deletion (Super Admin) --------------------------- */

interface DeletionImpact { schemeId: string; schemeName: string; dealerPlans: number; instances: number; installments: number; installmentRules: number; states: number }
const MIN_DELETE_REASON = 10;

/**
 * Two-step, high-friction permanent deletion. Step 1 warns + collects a mandatory reason (≥10 chars);
 * step 2 shows the real DB-computed impact counts + the reason and requires a final "Permanently Delete".
 * The button self-disables while the request is in flight (double-submit guard). Nothing is deleted until
 * the final click; Cancel at any point aborts with no changes. Authorization is also enforced server-side.
 */
function DeleteSchemeDialog({ group, onClose, onDeleted }: { group: SchemeGroup; onClose: () => void; onDeleted: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= MIN_DELETE_REASON;

  // Real impact counts, fetched once when the dialog opens (never inferred).
  const { data: impact, isLoading: impactLoading } = useQuery<DeletionImpact>({
    queryKey: ["scheme-deletion-impact", group.schemeId],
    queryFn: () => api.get(`/api/schemes/${group.schemeId}/deletion-impact`),
  });

  const del = useMutation({
    mutationFn: () => api.del(`/api/schemes/${group.schemeId}`, { reason: trimmed }),
    onSuccess: () => { alert(`Scheme '${group.schemeName}' was permanently deleted.`); onDeleted(); },
    onError: (e) => setError((e as Error).message || "Scheme could not be deleted. No changes were made."),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !del.isPending) onClose(); }}>
      <DialogContent className="max-w-md">
        {step === 1 ? (
          <>
            <DialogHeader><DialogTitle className="flex items-center gap-2 text-destructive"><AlertTriangle className="h-5 w-5" /> Delete Scheme</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">You are about to permanently delete:</p>
              <p className="text-center text-2xl font-bold">{group.schemeName}</p>
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                This permanently removes this scheme and all its related planning, enrollment, instance, installment and other scheme-owned records. This action cannot be undone.
              </div>
              <div className="space-y-1.5">
                <Label>Reason for deletion *</Label>
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus placeholder="Enter the reason for permanently deleting this scheme" />
                <p className="text-xs text-muted-foreground">Required — at least {MIN_DELETE_REASON} characters.</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={!reasonValid} onClick={() => { setError(null); setStep(2); }}>Continue</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader><DialogTitle className="flex items-center gap-2 text-destructive"><AlertTriangle className="h-5 w-5" /> Permanently Delete Scheme?</DialogTitle></DialogHeader>
            <div className="space-y-3 text-sm">
              <p><span className="text-muted-foreground">Scheme:</span> <span className="font-semibold">{group.schemeName}</span></p>
              <div>
                <p className="text-muted-foreground">This will permanently remove:</p>
                {impactLoading ? (
                  <Skeleton className="mt-1 h-24 w-full" />
                ) : impact ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    <li>{impact.dealerPlans} dealer scheme plan{impact.dealerPlans === 1 ? "" : "s"}</li>
                    <li>{impact.instances} scheme instance{impact.instances === 1 ? "" : "s"}</li>
                    <li>{impact.installments} installment record{impact.installments === 1 ? "" : "s"}</li>
                    <li>{impact.installmentRules} installment rule{impact.installmentRules === 1 ? "" : "s"}</li>
                    <li>{impact.states} state link{impact.states === 1 ? "" : "s"}</li>
                  </ul>
                ) : (
                  <p className="mt-1 text-muted-foreground">Related scheme-owned records will also be permanently removed.</p>
                )}
              </div>
              <div>
                <p className="text-muted-foreground">Reason:</p>
                <p className="mt-0.5 whitespace-pre-wrap rounded-md border bg-muted/30 p-2 italic">&ldquo;{trimmed}&rdquo;</p>
              </div>
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>This action permanently deletes the scheme and its related records. This cannot be undone.</span>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={del.isPending} onClick={() => { if (!del.isPending) onClose(); }}>Cancel</Button>
              <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={del.isPending} onClick={() => { setError(null); del.mutate(); }}>{del.isPending ? "Deleting Scheme…" : "Permanently Delete"}</Button>
            </DialogFooter>
          </>
        )}
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

