"use client";

import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { CornerUpLeft, Send, Eye, ShieldCheck, ChevronRight, ChevronDown } from "lucide-react";
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
import { PlanStateBadge, SchemeStatusBadge, SchemePlanDialog, PLAN_STATUS_LABEL, type SchemePlan } from "./scheme-detail-dialog";
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
      <div className="overflow-auto rounded-lg border bg-background">
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
                    <TableRow className="cursor-pointer bg-muted/30 hover:bg-muted/50" onClick={() => toggle(g.schemeId)}>
                      <TableCell>{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
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
                        <TableCell colSpan={COLS + 1} className="bg-background p-0">
                          <div className="overflow-auto p-2">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Dealer</TableHead>
                                  <TableHead>Sales Officer</TableHead>
                                  <TableHead>State</TableHead>
                                  <TableHead>Conversion Date</TableHead>
                                  <TableHead>Plan Status</TableHead>
                                  <TableHead>Scheme Status</TableHead>
                                  <TableHead className="text-right">Actions</TableHead>
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
                                    <TableCell className="text-right">
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
                                        <Button size="sm" variant="ghost" onClick={() => setDetail(r)}><Eye className="h-4 w-4" /> Open</Button>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
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
const SO_BOOKING_LABEL: Record<string, string> = { RECEIVED: "Received", NOT_RECEIVED: "Not Received", PARTIAL: "Partial" };
const SO_DOC_LABEL: Record<string, string> = { IN_TRANSIT: "In Transit", RECEIVED: "Received", NOT_RECEIVED: "Not Received" };

/** Field / SO value / Admin final value verification. Admin values override SO; enrollment only when complete. */
function AdminVerifyDialog({ plan, onClose, onSaved }: { plan: SchemePlan; onClose: () => void; onSaved: () => void }) {
  const [convDate, setConvDate] = useState(toDateInput(plan.adminConversionDate ?? plan.conversionDate));
  const [booking, setBooking] = useState(plan.adminBookingStatus ?? "RECEIVED");
  const [bookingAmount, setBookingAmount] = useState(plan.adminBookingAmount != null ? String(plan.adminBookingAmount) : (plan.soBookingAmount != null ? String(plan.soBookingAmount) : ""));
  const [doc, setDoc] = useState(plan.adminDocumentStatus ?? "RECEIVED_HARD");
  const [billDate, setBillDate] = useState(toDateInput(plan.adminBillingDate ?? plan.billingDate));
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState<string | null>(null);

  const paymentOk = booking === "RECEIVED";
  const docOk = doc === "RECEIVED_SOFT" || doc === "RECEIVED_HARD";
  const eligible = paymentOk && docOk;
  const bookingMark = booking === "RECEIVED" ? "✓" : booking === "PARTIAL" ? "!" : "✕";
  const docMark = docOk ? "✓" : "✕";

  const body = (enroll: boolean) => ({
    adminConversionDate: convDate || null,
    adminBookingStatus: booking,
    adminBookingAmount: booking === "NOT_RECEIVED" ? 0 : (bookingAmount ? Number(bookingAmount) : null),
    adminDocumentStatus: doc,
    adminBillingDate: billDate || null,
    remarks: remarks.trim() || undefined,
    enroll,
  });
  const mut = useMutation({
    mutationFn: (enroll: boolean) => api.post(`/api/scheme-plans/${plan.id}/verify`, body(enroll)),
    onSuccess: onSaved,
    onError: (e) => setError((e as Error).message),
  });

  const Cell = ({ children }: { children: React.ReactNode }) => <td className="border-b px-3 py-2 align-top">{children}</td>;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Verify — {plan.schemeName} · {plan.dealerName}</DialogTitle></DialogHeader>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Field</th><th className="px-3 py-2">Sales Officer</th><th className="px-3 py-2">Admin Final</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <Cell><span className="font-medium">Conversion Date</span></Cell>
                <Cell>{plan.conversionDate ? formatDate(plan.conversionDate) : "—"}</Cell>
                <Cell><Input type="date" className="w-40" value={convDate} onChange={(e) => setConvDate(e.target.value)} /></Cell>
              </tr>
              <tr>
                <Cell><span className="font-medium">Booking Amount</span></Cell>
                <Cell>{plan.soBookingStatus ? `${SO_BOOKING_LABEL[plan.soBookingStatus] ?? plan.soBookingStatus}${plan.soBookingAmount != null ? ` · ${formatCurrency(plan.soBookingAmount)}` : ""}` : "—"}</Cell>
                <Cell>
                  <div className="flex items-center gap-2">
                    <NativeSelect className="w-36" value={booking} onChange={(e) => setBooking(e.target.value)} options={[{ value: "RECEIVED", label: "Received" }, { value: "NOT_RECEIVED", label: "Not Received" }, { value: "PARTIAL", label: "Partial" }]} />
                    {booking !== "NOT_RECEIVED" && <Input type="number" min="0" className="w-28" placeholder="Amount" value={bookingAmount} onChange={(e) => setBookingAmount(e.target.value)} />}
                    <span className={cn("font-semibold", bookingMark === "✓" ? "text-success" : bookingMark === "✕" ? "text-destructive" : "text-warning")}>{bookingMark}</span>
                  </div>
                </Cell>
              </tr>
              <tr>
                <Cell><span className="font-medium">Document</span></Cell>
                <Cell>{plan.soDocumentStatus ? SO_DOC_LABEL[plan.soDocumentStatus] ?? plan.soDocumentStatus : "—"}</Cell>
                <Cell>
                  <div className="flex items-center gap-2">
                    <NativeSelect className="w-52" value={doc} onChange={(e) => setDoc(e.target.value)} options={[{ value: "RECEIVED_SOFT", label: "Received Soft Copy" }, { value: "RECEIVED_HARD", label: "Received Hard Copy" }, { value: "NOT_RECEIVED", label: "Not Received" }]} />
                    <span className={cn("font-semibold", docMark === "✓" ? "text-success" : "text-destructive")}>{docMark}</span>
                  </div>
                </Cell>
              </tr>
              <tr>
                <Cell><span className="font-medium">Billing Date</span></Cell>
                <Cell>{plan.billingDate ? formatDate(plan.billingDate) : "—"}</Cell>
                <Cell><Input type="date" className="w-40" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></Cell>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="space-y-1.5">
          <Label>Remarks</Label>
          <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} placeholder="Optional" />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">{eligible ? "Payment and document are complete — the dealer can be enrolled." : "Enrollment needs payment Received and document Received. Otherwise you can only Save."}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="outline" disabled={mut.isPending} onClick={() => { setError(null); mut.mutate(false); }}>{mut.isPending ? "Saving…" : "Save"}</Button>
          <Button disabled={mut.isPending || !eligible} onClick={() => { setError(null); mut.mutate(true); }}>Enroll</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

