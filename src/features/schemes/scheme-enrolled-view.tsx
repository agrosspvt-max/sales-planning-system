"use client";

import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, ChevronDown, Eye, FileText } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const toDateInput = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : "");
const CALC_LABEL: Record<string, string> = { PERCENTAGE: "Percentage", FIXED_AMOUNT: "Fixed Amount" };
const STATUS_VARIANT: Record<string, "secondary" | "success" | "destructive" | "muted" | "default"> = {
  Enrolled: "secondary", "Installment Pending": "secondary", "Installment Received": "default", Completed: "success", Overdue: "destructive",
  PENDING: "secondary", RECEIVED: "success", OVERDUE: "destructive",
};
const StatusBadge = ({ s }: { s: string }) => <Badge variant={STATUS_VARIANT[s] ?? "muted"}>{s === "PENDING" ? "Pending" : s === "RECEIVED" ? "Received" : s === "OVERDUE" ? "Overdue" : s}</Badge>;

interface Installment { id: string; installmentNumber: number; plannedAmount: number; plannedDate: string | null; receivedAmount: number | null; receivedDate: string | null; status: string }
interface DealerRow { planId: string; dealerId: string; dealerName: string; salesOfficerName: string; state: string | null; billingDate: string | null; schemeValueWithoutGST: number; schemeValueWithGST: number; status: string; installments: Installment[] }
interface SchemeInfo {
  id: string; schemeName: string; startDate: string | null; endDate: string | null; bookingLastDate: string | null; isPerpetual: boolean;
  bookingAmount: number | null; schemeValueWithoutGST: number; schemeValueWithGST: number; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
  states: string[]; documentUrl: string | null; installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
}
interface Detail { scheme: SchemeInfo; dealers: DealerRow[]; canEditPlanned: boolean; canEditReceived: boolean }
interface ListRow { id: string; schemeName: string; enrolledDealers: number; startDate: string | null; endDate: string | null; isPerpetual: boolean; status: string }

/** Enrolled Scheme — role-aware operational view. List of enrolled schemes → per-scheme installment tracker. */
export function EnrolledSchemesView() {
  const [openScheme, setOpenScheme] = useState<{ id: string; name: string } | null>(null);
  if (openScheme) return <EnrolledSchemeDetail schemeId={openScheme.id} onBack={() => setOpenScheme(null)} />;
  return <EnrolledSchemeList onOpen={setOpenScheme} />;
}

function EnrolledSchemeList({ onOpen }: { onOpen: (s: { id: string; name: string }) => void }) {
  const { data, isLoading } = useQuery<ListRow[]>({ queryKey: ["enrolled-schemes"], queryFn: () => api.get("/api/schemes/enrolled") });
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

function EnrolledSchemeDetail({ schemeId, onBack }: { schemeId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Detail>({ queryKey: ["enrolled-scheme", schemeId], queryFn: () => api.get(`/api/schemes/${schemeId}/enrolled`) });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showDetails, setShowDetails] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["enrolled-scheme", schemeId] });

  const billing = useMutation({ mutationFn: (v: { planId: string; billingDate: string }) => api.patch(`/api/scheme-plans/${v.planId}/billing-date`, { billingDate: v.billingDate }), onSuccess: invalidate, onError: (e) => alert((e as Error).message) });
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
        <div className="overflow-auto rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Dealer Name</TableHead>
                <TableHead>Billing Date</TableHead>
                <TableHead className="text-right">Amount (Without GST)</TableHead>
                <TableHead className="text-right">Amount (With GST)</TableHead>
                <TableHead>Installments</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.dealers.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No enrolled dealers.</TableCell></TableRow>
              ) : (
                data.dealers.map((d) => {
                  const open = expanded.has(d.planId);
                  return (
                    <Fragment key={d.planId}>
                      <TableRow>
                        <TableCell className="cursor-pointer" onClick={() => toggle(d.planId)}>{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                        <TableCell className="font-medium">{d.dealerName}</TableCell>
                        <TableCell>
                          {data.canEditPlanned ? (
                            <Input type="date" className="w-40" defaultValue={toDateInput(d.billingDate)} onBlur={(e) => { const v = e.target.value; if (v && v !== toDateInput(d.billingDate)) billing.mutate({ planId: d.planId, billingDate: v }); }} />
                          ) : (d.billingDate ? formatDate(d.billingDate) : "—")}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(d.schemeValueWithoutGST)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(d.schemeValueWithGST)}</TableCell>
                        <TableCell><button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => toggle(d.planId)}>{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{d.installments.length}</button></TableCell>
                        <TableCell><StatusBadge s={d.status} /></TableCell>
                      </TableRow>
                      {open && (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted/20 p-0">
                            <div className="overflow-auto p-2">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Installment</TableHead>
                                    <TableHead className="text-right">Planned Amount</TableHead>
                                    <TableHead>Planned Date</TableHead>
                                    <TableHead className="text-right">Received Amount</TableHead>
                                    <TableHead>Actual Date</TableHead>
                                    <TableHead>Status</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {d.installments.length === 0 ? (
                                    <TableRow><TableCell colSpan={6} className="py-4 text-center text-muted-foreground">No installment rules on this scheme.</TableCell></TableRow>
                                  ) : (
                                    d.installments.map((i) => (
                                      <TableRow key={i.id}>
                                        <TableCell className="font-medium">{ordinal(i.installmentNumber)} Installment</TableCell>
                                        <TableCell className="text-right">
                                          {data.canEditPlanned ? (
                                            <Input type="number" min="0" className="w-28 text-right" defaultValue={String(i.plannedAmount)} onBlur={(e) => { const v = Number(e.target.value); if (v !== i.plannedAmount) patchInst.mutate({ id: i.id, body: { plannedAmount: v } }); }} />
                                          ) : formatCurrency(i.plannedAmount)}
                                        </TableCell>
                                        <TableCell>
                                          {data.canEditPlanned ? (
                                            <Input type="date" className="w-40" defaultValue={toDateInput(i.plannedDate)} onBlur={(e) => { const v = e.target.value; if (v !== toDateInput(i.plannedDate)) patchInst.mutate({ id: i.id, body: { plannedDate: v || null } }); }} />
                                          ) : (i.plannedDate ? formatDate(i.plannedDate) : "—")}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          {data.canEditReceived ? (
                                            <Input type="number" min="0" className="w-28 text-right" defaultValue={i.receivedAmount == null ? "" : String(i.receivedAmount)} placeholder="—" onBlur={(e) => { const raw = e.target.value.trim(); const v = raw === "" ? null : Number(raw); if (v !== i.receivedAmount) patchInst.mutate({ id: i.id, body: { receivedAmount: v } }); }} />
                                          ) : (i.receivedAmount == null ? "—" : formatCurrency(i.receivedAmount))}
                                        </TableCell>
                                        <TableCell>
                                          {data.canEditReceived ? (
                                            <Input type="date" className="w-40" defaultValue={toDateInput(i.receivedDate)} onBlur={(e) => { const v = e.target.value; if (v !== toDateInput(i.receivedDate)) patchInst.mutate({ id: i.id, body: { receivedDate: v || null } }); }} />
                                          ) : (i.receivedDate ? formatDate(i.receivedDate) : "—")}
                                        </TableCell>
                                        <TableCell><StatusBadge s={i.status} /></TableCell>
                                      </TableRow>
                                    ))
                                  )}
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

      {showDetails && scheme && <SchemeDetailsModal scheme={scheme} onClose={() => setShowDetails(false)} />}
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
