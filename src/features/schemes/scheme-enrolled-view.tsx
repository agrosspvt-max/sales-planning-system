"use client";

import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, ChevronDown, Eye, FileText, IndianRupee } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { L } from "@/features/labels/label-ui";
import { schemeTable } from "./scheme-table-theme";

const toDateInput = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : "");
const CALC_LABEL: Record<string, string> = { PERCENTAGE: "Percentage", FIXED_AMOUNT: "Fixed Amount" };
const STATUS_VARIANT: Record<string, "secondary" | "success" | "destructive" | "muted" | "default"> = {
  Enrolled: "secondary", "Installment Pending": "secondary", "Installment Received": "default", Completed: "success", Overdue: "destructive",
  PENDING: "secondary", RECEIVED: "success", OVERDUE: "destructive", PARTIAL: "default",
};
const StatusBadge = ({ s }: { s: string }) => <Badge variant={STATUS_VARIANT[s] ?? "muted"}>{s === "PENDING" ? "Pending" : s === "RECEIVED" ? "Received" : s === "OVERDUE" ? "Overdue" : s === "PARTIAL" ? "Partial" : s}</Badge>;

const pctOf = (received: number | null, planned: number) => (planned > 0 ? ((received ?? 0) / planned) * 100 : 0);
/** Installment status as the Payment feature presents it: Settled (full) / Partial · % / Pending / Overdue. */
function InstallmentStatusBadge({ i }: { i: Installment }) {
  if (i.status === "PARTIAL") return <Badge variant="default">Partial · {pctOf(i.receivedAmount, i.plannedAmount).toFixed(2)}%</Badge>;
  if (i.status === "RECEIVED") return <Badge variant="success">Settled</Badge>;
  return <StatusBadge s={i.status} />;
}

interface Installment { id: string; installmentNumber: number; plannedAmount: number; plannedDate: string | null; receivedAmount: number | null; receivedDate: string | null; status: string }
interface InstanceRow { instanceId: string; instanceNumber: number; billingDate: string | null; status: string; installments: Installment[] }
interface DealerRow { planId: string; dealerId: string; dealerName: string; salesOfficerName: string; state: string | null; numberOfSchemes: number; billingDate: string | null; schemeValueWithoutGST: number; schemeValueWithGST: number; status: string; instances: InstanceRow[]; installments: Installment[] }
interface SchemeInfo {
  id: string; schemeName: string; startDate: string | null; endDate: string | null; bookingLastDate: string | null; isPerpetual: boolean;
  bookingAmount: number | null; schemeValueWithoutGST: number; schemeValueWithGST: number; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
  states: string[]; documentUrl: string | null; installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
}
interface Detail { scheme: SchemeInfo; dealers: DealerRow[]; canEditPlanned: boolean; canEditReceived: boolean }
interface ListRow { id: string; schemeName: string; enrolledDealers: number; startDate: string | null; endDate: string | null; isPerpetual: boolean; status: string }

/** Enrolled Scheme — role-aware operational view. List of enrolled schemes → per-scheme installment tracker.
 *  Optional `officerId` scopes an RM to one team Sales Officer (server-validated); omitted = full scope. */
export function EnrolledSchemesView({ officerId }: { officerId?: string } = {}) {
  const [openScheme, setOpenScheme] = useState<{ id: string; name: string } | null>(null);
  if (openScheme) return <EnrolledSchemeDetail schemeId={openScheme.id} officerId={officerId} onBack={() => setOpenScheme(null)} />;
  return <EnrolledSchemeList officerId={officerId} onOpen={setOpenScheme} />;
}

function EnrolledSchemeList({ onOpen, officerId }: { onOpen: (s: { id: string; name: string }) => void; officerId?: string }) {
  const { data, isLoading } = useQuery<ListRow[]>({ queryKey: ["enrolled-schemes", officerId ?? "all"], queryFn: () => api.get(`/api/schemes/enrolled${officerId ? `?officerId=${encodeURIComponent(officerId)}` : ""}`) });
  return (
    <div className="overflow-auto rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scheme Name</TableHead>
            <TableHead>Dealers</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
          ) : (data?.length ?? 0) === 0 ? (
            <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">No enrolled schemes yet.</TableCell></TableRow>
          ) : (
            data!.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium"><button type="button" className="text-left text-primary hover:underline" onClick={() => onOpen({ id: s.id, name: s.schemeName })}>{s.schemeName}</button></TableCell>
                <TableCell>{s.enrolledDealers} Dealer{s.enrolledDealers === 1 ? "" : "s"}</TableCell>
                <TableCell>{s.isPerpetual ? "Perpetual" : `${formatDate(s.startDate)} – ${formatDate(s.endDate)}`}</TableCell>
                <TableCell><Badge variant={s.status === "Running" ? "success" : "muted"}>{s.status}</Badge></TableCell>
                <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => onOpen({ id: s.id, name: s.schemeName })}><Eye className="h-4 w-4" /> Open</Button></TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function EnrolledSchemeDetail({ schemeId, onBack, officerId }: { schemeId: string; onBack: () => void; officerId?: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Detail>({ queryKey: ["enrolled-scheme", schemeId, officerId ?? "all"], queryFn: () => api.get(`/api/schemes/${schemeId}/enrolled${officerId ? `?officerId=${encodeURIComponent(officerId)}` : ""}`) });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showDetails, setShowDetails] = useState(false);
  // Confirm-before-save for a billing-date change (per instance). resetKey remounts inputs to revert on Cancel.
  const [billingConfirm, setBillingConfirm] = useState<{ instanceId: string; date: string } | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [payFor, setPayFor] = useState<DealerRow | null>(null); // Add Payment target dealer plan
  const invalidate = () => qc.invalidateQueries({ queryKey: ["enrolled-scheme", schemeId] });

  // Per-instance billing edit (Phase 2): editing one instance recomputes only that instance's schedule.
  const billing = useMutation({ mutationFn: (v: { instanceId: string; billingDate: string }) => api.patch(`/api/scheme-instances/${v.instanceId}/billing-date`, { billingDate: v.billingDate }), onSuccess: invalidate, onError: (e) => alert((e as Error).message) });
  const patchInst = useMutation({ mutationFn: (v: { id: string; body: Record<string, unknown> }) => api.patch(`/api/scheme-installments/${v.id}`, v.body), onSuccess: invalidate, onError: (e) => alert((e as Error).message) });

  const toggle = (id: string) => setExpanded((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const scheme = data?.scheme;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{scheme?.schemeName ?? "…"}</h2>
          {scheme && (
            <p className="mt-1 text-sm text-muted-foreground">
              {scheme.isPerpetual ? "Perpetual scheme" : `${formatDate(scheme.startDate)} – ${formatDate(scheme.endDate)}`}
              {" · "}Last Booking: {scheme.isPerpetual ? "—" : formatDate(scheme.bookingLastDate)}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowDetails(true)} disabled={!scheme}><FileText className="h-4 w-4" /> Scheme Details</Button>
          <Button variant="outline" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</Button>
        </div>
      </div>

      {isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className={schemeTable.outer}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead><L k="scheme_planning.enrolled.col.dealer_name" /></TableHead>
                <TableHead><L k="scheme_planning.enrolled.col.billing_date" /></TableHead>
                <TableHead className="text-right"><L k="scheme_planning.enrolled.col.amount_without_gst" /></TableHead>
                <TableHead className="text-right"><L k="scheme_planning.enrolled.col.amount_with_gst" /></TableHead>
                <TableHead><L k="scheme_planning.enrolled.col.installments" /></TableHead>
                <TableHead><L k="scheme_planning.enrolled.col.status" /></TableHead>
                {data.canEditReceived && <TableHead className="text-right"><L k="scheme_planning.enrolled.col.actions" /></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.dealers.length === 0 ? (
                <TableRow><TableCell colSpan={data.canEditReceived ? 8 : 7} className="py-10 text-center text-muted-foreground">No enrolled dealers.</TableCell></TableRow>
              ) : (
                data.dealers.map((d) => {
                  const open = expanded.has(d.planId);
                  return (
                    <Fragment key={d.planId}>
                      <TableRow className={cn(schemeTable.parentRow, open && schemeTable.parentRowOpen)}>
                        <TableCell className="cursor-pointer" onClick={() => toggle(d.planId)}>{open ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                        <TableCell className="font-medium">{d.dealerName}{d.numberOfSchemes > 1 && <span className="ml-2 text-xs text-muted-foreground">{d.numberOfSchemes} schemes</span>}</TableCell>
                        <TableCell>
                          {d.numberOfSchemes > 1 ? (
                            <span className="text-muted-foreground">Per scheme</span>
                          ) : data.canEditPlanned && d.instances[0] ? (
                            <Input key={`bill-${d.instances[0].instanceId}-${resetKey}`} type="date" className="w-40" defaultValue={toDateInput(d.instances[0].billingDate)} onBlur={(e) => { const v = e.target.value; const inst = d.instances[0]; if (v && inst && v !== toDateInput(inst.billingDate)) setBillingConfirm({ instanceId: inst.instanceId, date: v }); }} />
                          ) : (d.billingDate ? formatDate(d.billingDate) : "—")}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(d.schemeValueWithoutGST)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(d.schemeValueWithGST)}</TableCell>
                        <TableCell><button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => toggle(d.planId)}>{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{d.instances.reduce((a, x) => a + x.installments.length, 0)}</button></TableCell>
                        <TableCell><StatusBadge s={d.status} /></TableCell>
                        {data.canEditReceived && (
                          <TableCell className="text-right">
                            <Button size="sm" variant="outline" onClick={() => setPayFor(d)}><IndianRupee className="h-4 w-4" /> Add Payment</Button>
                          </TableCell>
                        )}
                      </TableRow>
                      {open && (
                        <TableRow>
                          <TableCell colSpan={data.canEditReceived ? 8 : 7} className={schemeTable.nestedCell}>
                           <div className={schemeTable.nestedInset}>
                            {d.numberOfSchemes <= 1 ? (
                              <div className={schemeTable.nestedShell}>
                                <InstallmentTable installments={d.instances[0]?.installments ?? []} canEditPlanned={data.canEditPlanned} onPatch={(id, body) => patchInst.mutate({ id, body })} />
                              </div>
                            ) : (
                              <div className="space-y-3">
                                {d.instances.map((inst) => (
                                  <div key={inst.instanceId} className="rounded-md border bg-background">
                                    <div className="flex flex-wrap items-center justify-between gap-2 border-b p-2">
                                      <div className="flex items-center gap-2 text-sm font-medium">Scheme {inst.instanceNumber} <StatusBadge s={inst.status} /></div>
                                      <div className="flex items-center gap-2 text-sm">
                                        <span className="text-muted-foreground">Billing Date</span>
                                        {data.canEditPlanned ? (
                                          <Input key={`bill-${inst.instanceId}-${resetKey}`} type="date" className="w-40" defaultValue={toDateInput(inst.billingDate)} onBlur={(e) => { const v = e.target.value; if (v && v !== toDateInput(inst.billingDate)) setBillingConfirm({ instanceId: inst.instanceId, date: v }); }} />
                                        ) : <span>{inst.billingDate ? formatDate(inst.billingDate) : "—"}</span>}
                                      </div>
                                    </div>
                                    <div className="p-2">
                                      <InstallmentTable installments={inst.installments} canEditPlanned={data.canEditPlanned} onPatch={(id, body) => patchInst.mutate({ id, body })} />
                                    </div>
                                  </div>
                                ))}
                              </div>
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

      {showDetails && scheme && <SchemeDetailsModal scheme={scheme} onClose={() => setShowDetails(false)} />}

      {payFor && scheme && <AddPaymentDialog dealer={payFor} schemeName={scheme.schemeName} onClose={() => setPayFor(null)} onSaved={() => { setPayFor(null); invalidate(); }} />}

      {billingConfirm && (
        <Dialog open onOpenChange={(o) => { if (!o) { setBillingConfirm(null); setResetKey((k) => k + 1); } }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Confirm billing date</DialogTitle></DialogHeader>
            <div className="space-y-3 py-2 text-center">
              <p className="text-sm text-muted-foreground">Are you sure that the billing date is</p>
              <p className="text-3xl font-semibold tabular-nums">{billingConfirm.date.split("-").reverse().join("/")}</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setBillingConfirm(null); setResetKey((k) => k + 1); }}>Cancel</Button>
              <Button disabled={billing.isPending} onClick={() => { const c = billingConfirm; setBillingConfirm(null); billing.mutate({ instanceId: c.instanceId, billingDate: c.date }); }}>Update</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** One instance's installment schedule (shared by single- and multi-instance dealers). */
function InstallmentTable({ installments, canEditPlanned, onPatch }: { installments: Installment[]; canEditPlanned: boolean; onPatch: (id: string, body: Record<string, unknown>) => void }) {
  return (
    <div className="overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead><L k="scheme_planning.enrolled.inst.installment" /></TableHead>
            <TableHead className="text-right"><L k="scheme_planning.enrolled.inst.planned_amount" /></TableHead>
            <TableHead><L k="scheme_planning.enrolled.inst.planned_date" /></TableHead>
            <TableHead className="text-right"><L k="scheme_planning.enrolled.inst.received_amount" /></TableHead>
            <TableHead><L k="scheme_planning.enrolled.inst.actual_date" /></TableHead>
            <TableHead><L k="scheme_planning.enrolled.inst.status" /></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {installments.length === 0 ? (
            <TableRow><TableCell colSpan={6} className="py-4 text-center text-muted-foreground">No installment rules on this scheme.</TableCell></TableRow>
          ) : (
            installments.map((i) => (
              <TableRow key={i.id}>
                <TableCell className="font-medium">{ordinal(i.installmentNumber)} Installment</TableCell>
                <TableCell className="text-right">
                  {canEditPlanned ? (
                    <Input type="number" min="0" className="w-28 text-right" defaultValue={String(i.plannedAmount)} onBlur={(e) => { const v = Number(e.target.value); if (v !== i.plannedAmount) onPatch(i.id, { plannedAmount: v }); }} />
                  ) : formatCurrency(i.plannedAmount)}
                </TableCell>
                <TableCell>
                  {canEditPlanned ? (
                    <Input type="date" className="w-40" defaultValue={toDateInput(i.plannedDate)} onBlur={(e) => { const v = e.target.value; if (v !== toDateInput(i.plannedDate)) onPatch(i.id, { plannedDate: v || null }); }} />
                  ) : (i.plannedDate ? formatDate(i.plannedDate) : "—")}
                </TableCell>
                {/* Received amount / date are READ-ONLY — they are the rollup of recorded payments (Add Payment). */}
                <TableCell className="text-right">{i.receivedAmount == null ? "—" : formatCurrency(i.receivedAmount)}</TableCell>
                <TableCell>{i.receivedDate ? formatDate(i.receivedDate) : "—"}</TableCell>
                <TableCell><InstallmentStatusBadge i={i} /></TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function SchemeDetailsModal({ scheme, onClose }: { scheme: SchemeInfo; onClose: () => void }) {
  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0"><span className="text-muted-foreground">{label}</span><span className="text-right font-medium">{value}</span></div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{scheme.schemeName}</DialogTitle></DialogHeader>
        <div className="space-y-0.5">
          <Row label="Applicable States" value={scheme.states.join(", ") || "—"} />
          <Row label="Start Date" value={scheme.isPerpetual ? "Perpetual" : formatDate(scheme.startDate)} />
          <Row label="End Date" value={scheme.isPerpetual ? "—" : formatDate(scheme.endDate)} />
          <Row label="Last Booking Date" value={scheme.isPerpetual ? "—" : formatDate(scheme.bookingLastDate)} />
          <Row label="Booking Amount" value={scheme.bookingAmount == null ? "—" : formatCurrency(scheme.bookingAmount)} />
          <Row label="Scheme Value (Without GST)" value={formatCurrency(scheme.schemeValueWithoutGST)} />
          <Row label="Scheme Value (With GST)" value={formatCurrency(scheme.schemeValueWithGST)} />
          <Row label="Scheme Benefit" value={`${scheme.schemeBenefit}${scheme.benefitDetails ? ` · ${scheme.benefitDetails}` : ""}`} />
          <Row label="Other Benefit Details" value={scheme.otherBenefitDetails || "—"} />
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
        {scheme.documentUrl && <a href={scheme.documentUrl} target="_blank" rel="noreferrer" className={cn("inline-flex items-center gap-1 text-sm text-primary hover:underline")}><FileText className="h-4 w-4" /> Download Scheme Document</a>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/* --------------------------- Add Payment (per dealer, Super Admin) --------------------------- */

const round2 = (n: number) => Math.round(n * 100) / 100;
interface PreviewLine { instanceNumber: number; installmentNumber: number; allocated: number; plannedAmount: number; newReceived: number; settled: boolean }

/** Client-side allocation preview — mirrors the server's `allocatePayment` so the modal shows exactly where
 *  the money will go before confirming. The server re-computes and remains authoritative. */
function previewAllocation(dealer: DealerRow, amount: number): { lines: PreviewLine[]; leftover: number; totalOutstanding: number } {
  const items = dealer.instances
    .flatMap((inst) => inst.installments.map((i) => ({ ...i, instanceNumber: inst.instanceNumber })))
    .sort((a, b) => a.instanceNumber - b.instanceNumber || a.installmentNumber - b.installmentNumber);
  const totalOutstanding = round2(items.reduce((s, i) => s + Math.max(0, round2(i.plannedAmount - (i.receivedAmount ?? 0))), 0));
  let left = round2(amount);
  const lines: PreviewLine[] = [];
  for (const i of items) {
    if (left <= 0.005) break;
    const rem = round2(i.plannedAmount - (i.receivedAmount ?? 0));
    if (rem <= 0.005) continue;
    const allocated = round2(Math.min(left, rem));
    const newReceived = round2((i.receivedAmount ?? 0) + allocated);
    lines.push({ instanceNumber: i.instanceNumber, installmentNumber: i.installmentNumber, allocated, plannedAmount: i.plannedAmount, newReceived, settled: newReceived + 0.005 >= i.plannedAmount });
    left = round2(left - allocated);
  }
  return { lines, leftover: round2(left), totalOutstanding };
}

function AddPaymentDialog({ dealer, schemeName, onClose, onSaved }: { dealer: DealerRow; schemeName: string; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const amt = Number(amount);
  const valid = amount.trim() !== "" && amt > 0 && !!date;
  const preview = valid ? previewAllocation(dealer, amt) : null;
  const overpay = preview ? preview.leftover > 0.005 : false;
  const multi = dealer.numberOfSchemes > 1;

  const save = useMutation({
    mutationFn: () => api.post(`/api/scheme-plans/${dealer.planId}/payments`, { amount: amt, receivedDate: date }),
    onSuccess: onSaved,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add Payment</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">Dealer: <span className="font-medium text-foreground">{dealer.dealerName}</span> · Scheme: <span className="font-medium text-foreground">{schemeName}</span></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Payment Amount *</Label><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus /></div>
            <div className="space-y-1.5"><Label>Payment Received Date *</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          {preview && (
            <div className="space-y-1.5">
              <Label>Allocation Preview</Label>
              <div className="overflow-hidden rounded-md border">
                <Table>
                  <TableHeader><TableRow><TableHead>Installment</TableHead><TableHead className="text-right">Allocated</TableHead><TableHead>Result</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {preview.lines.length === 0 ? (
                      <TableRow><TableCell colSpan={3} className="py-3 text-center text-muted-foreground">Nothing outstanding to allocate.</TableCell></TableRow>
                    ) : (
                      preview.lines.map((l, idx) => (
                        <TableRow key={idx}>
                          <TableCell>{multi ? `S${l.instanceNumber} · ` : ""}{ordinal(l.installmentNumber)} Installment</TableCell>
                          <TableCell className="text-right tabular-nums">{formatCurrency(l.allocated)}</TableCell>
                          <TableCell>{l.settled ? <Badge variant="success">Settled</Badge> : <Badge variant="default">Partial · {((l.newReceived / l.plannedAmount) * 100).toFixed(2)}%</Badge>}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground">Outstanding balance: {formatCurrency(preview.totalOutstanding)}. Recorded date-time is added automatically.</p>
              {overpay && <p className="text-xs text-destructive">Exceeds the outstanding balance by {formatCurrency(preview.leftover)}. Advance/excess payments are not supported — reduce the amount.</p>}
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={save.isPending} onClick={onClose}>Cancel</Button>
          <Button disabled={!valid || overpay || save.isPending} onClick={() => { setError(null); save.mutate(); }}>{save.isPending ? "Saving…" : "Add Payment"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
