"use client";

import { useState } from "react";
import { FileText, Lock, Unlock, Pencil, Plus, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatDate, formatCurrency, cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SchemeDetailDialog } from "./scheme-detail-dialog";
import { EnrolledSchemesView } from "./scheme-enrolled-view";

/** A non-perpetual scheme whose end date has already passed is EXPIRED — auto-closed, not reopenable. */
const isExpired = (s: Scheme) => !s.isPerpetual && !!s.endDate && new Date(s.endDate) < new Date();

type Benefit = "DOMESTIC_TOUR" | "DOMESTIC_COUPLE_TOUR" | "FOREIGN_TOUR" | "CREDIT_NOTE" | "OTHER";
type CalcType = "PERCENTAGE" | "FIXED_AMOUNT";
type Installment = { installmentNumber: number; calculationType: CalcType; value: number; daysAfterBillingDate: number };
type State = { id: string; name: string };
type Scheme = { id: string; schemeName: string; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null; schemeValueWithoutGST: number; schemeValueWithGST: number; bookingAmount: number | null; schemeBenefit: Benefit; benefitDetails: string | null; otherBenefitDetails: string | null; allowMultipleSchemes: boolean; documentUrl: string | null; status: "OPEN" | "CLOSED"; states: State[]; installments: Installment[] };
const benefits: Record<Benefit, string> = { DOMESTIC_TOUR: "Domestic Tour", DOMESTIC_COUPLE_TOUR: "Domestic Couple Tour", FOREIGN_TOUR: "Foreign Tour", CREDIT_NOTE: "Credit Note", OTHER: "Other" };
const toDateInput = (v: string | null) => v ? new Date(v).toISOString().slice(0, 10) : "";

export function SchemeMasterPage({ canManage = true }: { canManage?: boolean }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [state, setState] = useState("");
  const [create, setCreate] = useState(false);
  const [editing, setEditing] = useState<Scheme | null>(null);
  const [detail, setDetail] = useState<Scheme | null>(null);
  const [closing, setClosing] = useState<Scheme | null>(null);
  const [reopening, setReopening] = useState<Scheme | null>(null);
  const [view, setView] = useState<"master" | "enrolled">("master");
  const { data: states = [] } = useQuery<State[]>({ queryKey: ["scheme-state-options"], queryFn: () => api.get("/api/schemes/options") });
  const { data, isLoading } = useQuery<Scheme[]>({ queryKey: ["schemes", status, state], queryFn: () => api.get(`/api/schemes?status=${status}&state=${state}`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["schemes"] });
  const close = useMutation({ mutationFn: (id: string) => api.post(`/api/schemes/${id}/close`, {}), onSuccess: invalidate });
  const reopen = useMutation({ mutationFn: (id: string) => api.post(`/api/schemes/${id}/reopen`, {}), onSuccess: invalidate, onError: (e) => alert((e as Error).message) });
  return <div className="space-y-5">
    <PageHeader crumbs={[{ label: canManage ? "Masters" : "Planning" }, { label: "Scheme Master" }]} title="Scheme Master" subtitle={canManage ? "Create and manage commercial schemes by State." : "Available commercial schemes by State."} actions={<div className="flex gap-2"><NativeSelect className="w-32" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "", label: "All status" }, { value: "OPEN", label: "Open" }, { value: "CLOSED", label: "Closed" }]} /><NativeSelect className="w-40" value={state} onChange={(e) => setState(e.target.value)} options={[{ value: "", label: "All states" }, ...states.map((s) => ({ value: s.id, label: s.name }))]} />{canManage && <Button onClick={() => setCreate(true)}><Plus className="h-4 w-4" /> New Scheme</Button>}</div>} />
    <div className="flex gap-2">
      <button type="button" onClick={() => setView("master")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", view === "master" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}>View Scheme</button>
      <button type="button" onClick={() => setView("enrolled")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", view === "enrolled" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}>Enrolled Scheme</button>
    </div>
    {view === "enrolled" ? <EnrolledSchemesView /> : <div className="overflow-auto rounded-lg border bg-background"><Table stickyFirstColumn><TableHeader><TableRow><TableHead>Scheme Name</TableHead><TableHead>States</TableHead><TableHead>Scheme Period</TableHead><TableHead>Last Booking Date</TableHead><TableHead className="text-right">Without GST</TableHead><TableHead className="text-right">With GST</TableHead><TableHead>Benefit</TableHead><TableHead>Status</TableHead>{canManage && <TableHead className="text-right">Actions</TableHead>}</TableRow></TableHeader><TableBody>{isLoading ? <TableRow><TableCell colSpan={canManage ? 9 : 8}><Skeleton className="h-7 w-full" /></TableCell></TableRow> : !data?.length ? <TableRow><TableCell colSpan={canManage ? 9 : 8} className="py-10 text-center text-muted-foreground">No schemes found.</TableCell></TableRow> : data.map((s) => <TableRow key={s.id}><TableCell className="font-medium"><button type="button" className="text-left text-primary hover:underline" onClick={() => setDetail(s)} title="View dealer plans">{s.schemeName}</button>{s.documentUrl && <a href={s.documentUrl} target="_blank" rel="noreferrer" className="ml-2 inline-block text-primary" title="Open scheme document"><FileText className="h-4 w-4" /></a>}</TableCell><TableCell>{s.states.map((x) => x.name).join(", ")}</TableCell><TableCell>{s.isPerpetual ? "Perpetual" : `${formatDate(s.startDate!)} – ${formatDate(s.endDate!)}`}</TableCell><TableCell>{s.isPerpetual ? "—" : formatDate(s.bookingLastDate!)}</TableCell><TableCell className="text-right tabular-nums">{formatCurrency(s.schemeValueWithoutGST)}</TableCell><TableCell className="text-right tabular-nums">{formatCurrency(s.schemeValueWithGST)}</TableCell><TableCell>{benefits[s.schemeBenefit]}{s.benefitDetails ? ` · ${s.benefitDetails}` : ""}</TableCell><TableCell><Badge variant={s.status === "OPEN" ? "success" : "muted"}>{s.status}</Badge></TableCell>{canManage && <TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => setEditing(s)} title="Edit"><Pencil className="h-4 w-4" /></Button>{s.status === "OPEN" && <Button variant="ghost" size="sm" onClick={() => setClosing(s)} title="Close scheme" disabled={close.isPending}><Lock className="h-4 w-4" /></Button>}{s.status === "CLOSED" && !isExpired(s) && <Button variant="ghost" size="sm" onClick={() => setReopening(s)} title="Reopen scheme" disabled={reopen.isPending}><Unlock className="h-4 w-4" /></Button>}</TableCell>}</TableRow>)}</TableBody></Table></div>}
    {create && <SchemeDialog states={states} onClose={() => setCreate(false)} onSaved={() => { setCreate(false); invalidate(); }} />}{editing && <SchemeDialog scheme={editing} states={states} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />}
    {detail && <SchemeDetailDialog schemeId={detail.id} schemeName={detail.schemeName} canVerify={canManage} onClose={() => setDetail(null)} />}
    <ConfirmDialog
      open={!!closing}
      onOpenChange={(o) => !o && setClosing(null)}
      title="Close Scheme?"
      description="Are you sure you want to close this scheme? Sales Officers will no longer be able to plan new dealers into it."
      confirmLabel="Close Scheme"
      destructive
      onConfirm={() => { if (closing) close.mutate(closing.id); }}
    />
    <ConfirmDialog
      open={!!reopening}
      onOpenChange={(o) => !o && setReopening(null)}
      title="Reopen Scheme?"
      description="Are you sure you want to reopen this scheme? It will become available for eligible Sales Officers again."
      confirmLabel="Reopen Scheme"
      onConfirm={() => { if (reopening) reopen.mutate(reopening.id); }}
    />
  </div>;
}

function SchemeDialog({ scheme, states, onClose, onSaved }: { scheme?: Scheme; states: State[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(scheme?.schemeName ?? "");
  const [stateIds, setStateIds] = useState<string[]>(scheme?.states.map((s) => s.id) ?? []);
  const [isPerpetual, setIsPerpetual] = useState(scheme?.isPerpetual ?? false);
  const [startDate, setStartDate] = useState(scheme ? toDateInput(scheme.startDate) : "");
  const [endDate, setEndDate] = useState(scheme ? toDateInput(scheme.endDate) : "");
  const [bookingLastDate, setBookingLastDate] = useState(scheme ? toDateInput(scheme.bookingLastDate) : "");
  const [valueWithoutGST, setValueWithoutGST] = useState(scheme ? String(scheme.schemeValueWithoutGST) : "");
  const [valueWithGST, setValueWithGST] = useState(scheme ? String(scheme.schemeValueWithGST) : "");
  const [bookingAmount, setBookingAmount] = useState(scheme?.bookingAmount != null ? String(scheme.bookingAmount) : "");
  const [benefit, setBenefit] = useState<Benefit>(scheme?.schemeBenefit ?? "DOMESTIC_TOUR");
  const [benefitDetails, setBenefitDetails] = useState(scheme?.benefitDetails ?? "");
  const [otherBenefitDetails, setOtherBenefitDetails] = useState(scheme?.otherBenefitDetails ?? "");
  const [multiple, setMultiple] = useState(scheme?.allowMultipleSchemes ?? false);
  const [documentUrl, setDocumentUrl] = useState(scheme?.documentUrl ?? "");
  const [installments, setInstallments] = useState<Installment[]>(scheme?.installments ?? []);
  const [error, setError] = useState<string | null>(null);

  const gstValue = Number(valueWithGST) || 0;
  const calcType: CalcType = installments[0]?.calculationType ?? "PERCENTAGE";
  const installTotal = installments.reduce((sum, r) => sum + (Number(r.value) || 0), 0);
  const installTarget = calcType === "PERCENTAGE" ? 100 : gstValue;
  const installValid = installments.length === 0 || Math.round(installTotal * 100) === Math.round(installTarget * 100);

  const setCount = (n: number) => {
    setInstallments((prev) => {
      const type = prev[0]?.calculationType ?? "PERCENTAGE";
      return Array.from({ length: n }, (_, i) => prev[i] ?? { installmentNumber: i + 1, calculationType: type, value: 0, daysAfterBillingDate: 0 })
        .map((r, i) => ({ ...r, installmentNumber: i + 1 }));
    });
  };
  const updateRow = (idx: number, patch: Partial<Installment>) => setInstallments((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const setAllCalc = (t: CalcType) => setInstallments((prev) => prev.map((r) => ({ ...r, calculationType: t })));

  const payload = () => ({ schemeName: name, stateIds, isPerpetual, startDate: isPerpetual ? null : startDate, endDate: isPerpetual ? null : endDate, bookingLastDate: isPerpetual ? null : bookingLastDate, schemeValueWithoutGST: valueWithoutGST, schemeValueWithGST: valueWithGST, bookingAmount: bookingAmount === "" ? null : bookingAmount, schemeBenefit: benefit, benefitDetails: benefit === "OTHER" ? benefitDetails : null, otherBenefitDetails: otherBenefitDetails.trim() || null, allowMultipleSchemes: multiple, documentUrl: documentUrl || null, installments: installments.map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: Number(r.value) || 0, daysAfterBillingDate: Number(r.daysAfterBillingDate) || 0 })) });
  const save = useMutation({ mutationFn: () => scheme ? api.patch(`/api/schemes/${scheme.id}`, payload()) : api.post("/api/schemes", payload()), onSuccess: onSaved, onError: (e) => setError((e as Error).message) });
  const upload = (file?: File) => { if (!file) return; if (file.size > 3_500_000) { setError("Document must be smaller than 3.5 MB"); return; } const reader = new FileReader(); reader.onload = () => setDocumentUrl(String(reader.result)); reader.readAsDataURL(file); };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{scheme ? "Edit Scheme" : "Create Scheme"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Scheme Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Applicable States *</Label><div className="grid grid-cols-2 gap-2 rounded-md border p-3">{states.map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stateIds.includes(s.id)} onChange={() => setStateIds((ids) => ids.includes(s.id) ? ids.filter((id) => id !== s.id) : [...ids, s.id])} />{s.name}</label>)}</div></div>
          <label className="flex items-center gap-2 rounded-md border p-3 text-sm font-medium"><input type="checkbox" checked={isPerpetual} onChange={(e) => setIsPerpetual(e.target.checked)} />Perpetual Scheme</label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Scheme Start {!isPerpetual && "*"}</Label><Input disabled={isPerpetual} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Scheme End {!isPerpetual && "*"}</Label><Input disabled={isPerpetual} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Last Booking Date {!isPerpetual && "*"}</Label><Input disabled={isPerpetual} type="date" value={bookingLastDate} onChange={(e) => setBookingLastDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Booking Amount</Label><Input type="number" min="0" value={bookingAmount} onChange={(e) => setBookingAmount(e.target.value)} placeholder="Optional" /></div>
            <div className="space-y-1.5"><Label>Scheme Value (Without GST) *</Label><Input type="number" min="0" value={valueWithoutGST} onChange={(e) => setValueWithoutGST(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Scheme Value (With GST) *</Label><Input type="number" min="0" value={valueWithGST} onChange={(e) => setValueWithGST(e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Scheme Benefit *</Label><NativeSelect value={benefit} onChange={(e) => setBenefit(e.target.value as Benefit)} options={Object.entries(benefits).map(([value, label]) => ({ value, label }))} /></div>
            <div className="space-y-1.5"><Label>Allow Multiple Schemes</Label><NativeSelect value={multiple ? "yes" : "no"} onChange={(e) => setMultiple(e.target.value === "yes")} options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]} /></div>
          </div>
          {benefit === "OTHER" && <div className="space-y-1.5"><Label>Enter Benefit Details *</Label><Input value={benefitDetails} onChange={(e) => setBenefitDetails(e.target.value)} placeholder="e.g. Special Product Gift" /></div>}
          <div className="space-y-1.5"><Label>Other Benefit Details</Label><Input value={otherBenefitDetails} onChange={(e) => setOtherBenefitDetails(e.target.value)} placeholder="Optional additional notes" /></div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-semibold">Installment Rule Builder</Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">No. of Installments</span>
                <NativeSelect className="w-20" value={String(installments.length)} onChange={(e) => setCount(Number(e.target.value))} options={Array.from({ length: 11 }, (_, i) => ({ value: String(i), label: String(i) }))} />
              </div>
            </div>
            {installments.length > 0 && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Calculation Type</span>
                  <NativeSelect className="w-40" value={calcType} onChange={(e) => setAllCalc(e.target.value as CalcType)} options={[{ value: "PERCENTAGE", label: "Percentage" }, { value: "FIXED_AMOUNT", label: "Fixed Amount" }]} />
                </div>
                <div className="overflow-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead className="w-12">#</TableHead><TableHead>{calcType === "PERCENTAGE" ? "Percentage (%)" : "Amount (₹)"}</TableHead><TableHead>Days after Billing Date</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {installments.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-medium">{i + 1}</TableCell>
                          <TableCell><Input type="number" min="0" value={r.value === 0 ? "" : String(r.value)} onChange={(e) => updateRow(i, { value: Number(e.target.value) || 0 })} /></TableCell>
                          <TableCell><Input type="number" min="0" value={r.daysAfterBillingDate === 0 ? "" : String(r.daysAfterBillingDate)} onChange={(e) => updateRow(i, { daysAfterBillingDate: Number(e.target.value) || 0 })} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className={cn("text-xs", installValid ? "text-muted-foreground" : "text-destructive")}>
                  Total: {calcType === "PERCENTAGE" ? `${installTotal}%` : formatCurrency(installTotal)} {installValid ? "✓" : `— must equal ${calcType === "PERCENTAGE" ? "100%" : formatCurrency(installTarget)}`}
                </p>
              </>
            )}
          </div>

          <div className="space-y-1.5"><Label>Scheme Document</Label><Input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,image/*" onChange={(e) => upload(e.target.files?.[0])} />{documentUrl && <div className="flex items-center gap-2 text-xs text-muted-foreground"><FileText className="h-4 w-4" />Document attached <Button variant="ghost" size="sm" onClick={() => setDocumentUrl("")}><X className="h-3 w-3" /></Button></div>}</div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim() || !stateIds.length || (!isPerpetual && (!startDate || !endDate || !bookingLastDate)) || valueWithoutGST === "" || valueWithGST === "" || (benefit === "OTHER" && !benefitDetails.trim()) || !installValid || save.isPending} onClick={() => { setError(null); save.mutate(); }}>{scheme ? "Save Changes" : "Save Scheme"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
