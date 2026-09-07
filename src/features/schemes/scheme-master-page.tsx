"use client";

import { useState } from "react";
import { FileText, Lock, Unlock, Plus, X, MoreVertical, Info, Share2, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatDate, formatCurrency, cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { type Crumb } from "@/components/layout/crumb-trail";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLabel } from "@/features/labels/label-ui";
import { validateSchemeRequirement } from "@/lib/scheme-requirement";
import { SchemeDetailDialog } from "./scheme-detail-dialog";
import { EnrolledSchemesView } from "./scheme-enrolled-view";
// Reuse the EXACT Info / View Document / Share dialogs + helpers from the Planned Scheme (Create Plan) menu,
// so both menus stay identical. The Scheme Master row is adapted to the RunningScheme shape they expect.
import { SchemeInfoDialog, SchemeDocumentDialog, SchemeShareDialog, schemeShareText, schemeDocumentFile, type RunningScheme } from "./scheme-create-plan";

/** A non-perpetual scheme whose end date has already passed is EXPIRED — auto-closed, not reopenable. */
const isExpired = (s: Scheme) => !s.isPerpetual && !!s.endDate && new Date(s.endDate) < new Date();

type Benefit = "DOMESTIC_TOUR" | "DOMESTIC_COUPLE_TOUR" | "FOREIGN_TOUR" | "CREDIT_NOTE" | "OTHER";
type CalcType = "PERCENTAGE" | "FIXED_AMOUNT";
type Installment = { installmentNumber: number; calculationType: CalcType; value: number; daysAfterBillingDate: number };
type State = { id: string; name: string };
type ReqType = "NONE" | "PRODUCT_BASED" | "VALUE_BASED";
type ValueMode = "INDIVIDUAL" | "COMBINED";
type RequirementProduct = { productId: string; requiredQty: number | null; requiredValue: number | null };
type Scheme = { id: string; schemeName: string; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null; schemeValueWithoutGST: number; schemeValueWithGST: number; bookingAmount: number | null; schemeBenefit: Benefit; benefitDetails: string | null; otherBenefitDetails: string | null; allowMultipleSchemes: boolean; maxExtensionDays: number; maxExtensionAttempts: number; documentUrl: string | null; status: "OPEN" | "CLOSED"; states: State[]; installments: Installment[]; requirementType?: ReqType; valueMode?: ValueMode | null; combinedRequiredValue?: number | null; requirementProducts?: RequirementProduct[] };
type ProductOption = { productId: string; name: string; isActive: boolean };
const benefits: Record<Benefit, string> = { DOMESTIC_TOUR: "Domestic Tour", DOMESTIC_COUPLE_TOUR: "Domestic Couple Tour", FOREIGN_TOUR: "Foreign Tour", CREDIT_NOTE: "Credit Note", OTHER: "Other" };
const toDateInput = (v: string | null) => v ? new Date(v).toISOString().slice(0, 10) : "";
const MIN_DELETE_REASON = 10;

/** Adapt a Scheme Master row to the RunningScheme shape the shared Info/Document/Share dialogs expect
 *  (only difference: states as a name[] rather than {id,name}[]). Presentational reuse only. */
const toRunningScheme = (s: Scheme): RunningScheme => ({
  id: s.id, schemeName: s.schemeName, states: s.states.map((x) => x.name), isPerpetual: s.isPerpetual,
  startDate: s.startDate, endDate: s.endDate, bookingLastDate: s.bookingLastDate, schemeBenefit: s.schemeBenefit,
  benefitDetails: s.benefitDetails, schemeValueWithoutGST: s.schemeValueWithoutGST, schemeValueWithGST: s.schemeValueWithGST,
  documentUrl: s.documentUrl, bookingAmount: s.bookingAmount, otherBenefitDetails: s.otherBenefitDetails,
  allowMultipleSchemes: s.allowMultipleSchemes, installments: s.installments,
});

type DeletionImpact = { schemeId: string; schemeName: string; dealerPlans: number; instances: number; installments: number; installmentRules: number; states: number };

/** Per-row ⋮ menu for View All Scheme — same visual pattern as the Planned Scheme menu, with Edit Scheme +
 *  Delete Scheme added. Every item just triggers an existing handler; no business logic lives here. */
function SchemeRowMenu({ hasDocument, onInfo, onDoc, onShare, onEdit, onDelete }: { hasDocument: boolean; onInfo: () => void; onDoc: () => void; onShare: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" title="More actions"><MoreVertical className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onInfo}><Info className="h-4 w-4" /> {useLabel("scheme_master.action.info")}</DropdownMenuItem>
        <DropdownMenuItem disabled={!hasDocument} onSelect={onDoc}><FileText className="h-4 w-4" /> {useLabel("scheme_master.action.view_document")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onShare}><Share2 className="h-4 w-4" /> {useLabel("scheme_master.action.share")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}><Pencil className="h-4 w-4" /> {useLabel("scheme_master.action.edit_scheme")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="h-4 w-4" /> {useLabel("scheme_master.action.delete_scheme")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Two-step, high-friction permanent deletion — the SAME flow the Delete Scheme entry point used before, now
 * reached from the ⋮ menu. Step 1 warns + collects a mandatory reason (≥10 chars); step 2 shows the real
 * DB-computed impact counts + the reason and requires a final "Permanently Delete". The button self-disables
 * while the request is in flight (double-submit guard). It calls the exact existing endpoints
 * (GET .../deletion-impact, DELETE /api/schemes/:id) — no second delete implementation. Server enforces auth.
 */
function DeleteSchemeDialog({ schemeId, schemeName, onClose, onDeleted }: { schemeId: string; schemeName: string; onClose: () => void; onDeleted: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= MIN_DELETE_REASON;

  // Real impact counts, fetched once when the dialog opens (never inferred).
  const { data: impact, isLoading: impactLoading } = useQuery<DeletionImpact>({
    queryKey: ["scheme-deletion-impact", schemeId],
    queryFn: () => api.get(`/api/schemes/${schemeId}/deletion-impact`),
  });

  const del = useMutation({
    mutationFn: () => api.del(`/api/schemes/${schemeId}`, { reason: trimmed }),
    onSuccess: () => { alert(`Scheme '${schemeName}' was permanently deleted.`); onDeleted(); },
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
              <p className="text-center text-2xl font-bold">{schemeName}</p>
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
              <p><span className="text-muted-foreground">Scheme:</span> <span className="font-semibold">{schemeName}</span></p>
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

/**
 * Scheme Master — the single source of truth for creating and managing commercial schemes. Rendered by its
 * own Master Data route (/masters/schemes) and REUSED as Admin → Create Plan inside Scheme Planning, which is
 * why the two presentational props exist: `crumbs` re-parents the breadcrumb trail into whichever module is
 * hosting it, and `nav` slots that module's mode bar under the header. Both default to the Master Data
 * behaviour, so /masters/schemes renders exactly as before. No business logic is duplicated for the second
 * entry point — the same component, queries and endpoints serve both.
 *
 * `hideViewToggle` hides ONLY the internal "View Scheme | Enrolled Scheme" pill and pins the scheme-list
 * view. It exists so the Admin → Create Plan host can present its own two-option bar (View All Scheme |
 * Planned Scheme) without a nested pill row; it defaults to false, so /masters/schemes is unaffected. The
 * Enrolled Scheme view stays reachable from Master Data → Schemes and View Plan → Enrolled.
 *
 * `hideList` additionally suppresses the scheme-list table and its header actions (status/state filters +
 * New Scheme), leaving just the header + the host's `nav`. The Admin → Create Plan host uses this on its
 * "Planned Scheme" tab, where the scheme list is replaced by the Planned Dealers section rendered beneath.
 * Defaults to false.
 */
export function SchemeMasterPage({ canManage = true, crumbs, nav, hideViewToggle = false, hideList = false }: { canManage?: boolean; crumbs?: Crumb[]; nav?: React.ReactNode; hideViewToggle?: boolean; hideList?: boolean }) {
  const qc = useQueryClient();
  // Centrally-editable Scheme Master labels (Admin → Labels). Called unconditionally (rules of hooks).
  const ML = {
    title: useLabel("scheme_master.page.title"),
    subManage: useLabel("scheme_master.page.subtitle_manage"),
    subView: useLabel("scheme_master.page.subtitle_view"),
    allStatus: useLabel("scheme_master.filter.all_status"),
    allStates: useLabel("scheme_master.filter.all_states"),
    newScheme: useLabel("scheme_master.action.new_scheme"),
    viewScheme: useLabel("scheme_master.view.view_scheme"),
    enrolledScheme: useLabel("scheme_master.view.enrolled_scheme"),
    colName: useLabel("scheme_master.col.scheme_name"),
    colStates: useLabel("scheme_master.col.states"),
    colPeriod: useLabel("scheme_master.col.scheme_period"),
    colLastBooking: useLabel("scheme_master.col.last_booking_date"),
    colWithoutGst: useLabel("scheme_master.col.without_gst"),
    colWithGst: useLabel("scheme_master.col.with_gst"),
    colBenefit: useLabel("scheme_master.col.benefit"),
    colStatus: useLabel("scheme_master.col.status"),
    colActions: useLabel("scheme_master.col.actions"),
  };
  const [status, setStatus] = useState("");
  const [state, setState] = useState("");
  const [create, setCreate] = useState(false);
  const [editing, setEditing] = useState<Scheme | null>(null);
  const [detail, setDetail] = useState<Scheme | null>(null);
  const [closing, setClosing] = useState<Scheme | null>(null);
  const [reopening, setReopening] = useState<Scheme | null>(null);
  // ⋮ menu targets (View All Scheme). Info/Document/Share reuse the shared Planned Scheme dialogs.
  const [infoFor, setInfoFor] = useState<Scheme | null>(null);
  const [docFor, setDocFor] = useState<Scheme | null>(null);
  const [shareFor, setShareFor] = useState<Scheme | null>(null);
  const [deleting, setDeleting] = useState<Scheme | null>(null);
  const [view, setView] = useState<"master" | "enrolled">("master");
  const { data: states = [] } = useQuery<State[]>({ queryKey: ["scheme-state-options"], queryFn: () => api.get("/api/schemes/options") });
  const { data, isLoading } = useQuery<Scheme[]>({ queryKey: ["schemes", status, state], queryFn: () => api.get(`/api/schemes?status=${status}&state=${state}`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["schemes"] });
  const close = useMutation({ mutationFn: (id: string) => api.post(`/api/schemes/${id}/close`, {}), onSuccess: invalidate });
  const reopen = useMutation({ mutationFn: (id: string) => api.post(`/api/schemes/${id}/reopen`, {}), onSuccess: invalidate, onError: (e) => alert((e as Error).message) });
  // Share = the exact same behaviour as the Planned Scheme menu (Web Share API where available, else the
  // wa.me + copy fallback dialog). No messaging API, no server involvement.
  const shareScheme = async (s: Scheme) => {
    const rs = toRunningScheme(s);
    const text = schemeShareText(rs);
    const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { canShare?: (d: ShareData) => boolean });
    const file = schemeDocumentFile(rs);
    if (nav && file && nav.canShare?.({ files: [file] })) { try { await nav.share({ files: [file], title: s.schemeName, text }); return; } catch (e) { if ((e as Error).name === "AbortError") return; } }
    if (nav && typeof nav.share === "function") { try { await nav.share({ title: s.schemeName, text }); return; } catch (e) { if ((e as Error).name === "AbortError") return; } }
    setShareFor(s);
  };
  return <div className="space-y-5">
    <PageHeader crumbs={crumbs ?? [{ label: canManage ? "Masters" : "Planning" }, { label: ML.title }]} title={ML.title} subtitle={canManage ? ML.subManage : ML.subView} actions={hideList ? undefined : <div className="flex gap-2"><NativeSelect className="w-32" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "", label: ML.allStatus }, { value: "OPEN", label: "Open" }, { value: "CLOSED", label: "Closed" }]} /><NativeSelect className="w-40" value={state} onChange={(e) => setState(e.target.value)} options={[{ value: "", label: ML.allStates }, ...states.map((s) => ({ value: s.id, label: s.name }))]} />{canManage && <Button onClick={() => setCreate(true)}><Plus className="h-4 w-4" /> {ML.newScheme}</Button>}</div>} />
    {/* Host module's mode bar (Admin → Create Plan). Absent on the standalone Master Data route. */}
    {nav}
    {!hideViewToggle && (
    <div className="flex gap-2">
      <button type="button" onClick={() => setView("master")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", view === "master" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}>{ML.viewScheme}</button>
      <button type="button" onClick={() => setView("enrolled")} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", view === "enrolled" ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}>{ML.enrolledScheme}</button>
    </div>
    )}
    {hideList ? null : !hideViewToggle && view === "enrolled" ? <EnrolledSchemesView /> : <div className="overflow-auto rounded-lg border bg-background"><Table stickyFirstColumn><TableHeader><TableRow><TableHead>{ML.colName}</TableHead><TableHead>{ML.colStates}</TableHead><TableHead>{ML.colPeriod}</TableHead><TableHead>{ML.colLastBooking}</TableHead><TableHead className="text-right">{ML.colWithoutGst}</TableHead><TableHead className="text-right">{ML.colWithGst}</TableHead><TableHead>{ML.colBenefit}</TableHead><TableHead>{ML.colStatus}</TableHead>{canManage && <TableHead className="text-right">{ML.colActions}</TableHead>}</TableRow></TableHeader><TableBody>{isLoading ? <TableRow><TableCell colSpan={canManage ? 9 : 8}><Skeleton className="h-7 w-full" /></TableCell></TableRow> : !data?.length ? <TableRow><TableCell colSpan={canManage ? 9 : 8} className="py-10 text-center text-muted-foreground">No schemes found.</TableCell></TableRow> : data.map((s) => <TableRow key={s.id}><TableCell className="font-medium"><button type="button" className="text-left text-primary hover:underline" onClick={() => setDetail(s)} title="View dealer plans">{s.schemeName}</button>{s.documentUrl && <a href={s.documentUrl} target="_blank" rel="noreferrer" className="ml-2 inline-block text-primary" title="Open scheme document"><FileText className="h-4 w-4" /></a>}</TableCell><TableCell>{s.states.map((x) => x.name).join(", ")}</TableCell><TableCell>{s.isPerpetual ? "Perpetual" : `${formatDate(s.startDate!)} – ${formatDate(s.endDate!)}`}</TableCell><TableCell>{s.isPerpetual ? "—" : formatDate(s.bookingLastDate!)}</TableCell><TableCell className="text-right tabular-nums">{formatCurrency(s.schemeValueWithoutGST)}</TableCell><TableCell className="text-right tabular-nums">{formatCurrency(s.schemeValueWithGST)}</TableCell><TableCell>{benefits[s.schemeBenefit]}{s.benefitDetails ? ` · ${s.benefitDetails}` : ""}</TableCell><TableCell><Badge variant={s.status === "OPEN" ? "success" : "muted"}>{s.status}</Badge></TableCell>{canManage && <TableCell className="text-right"><div className="flex items-center justify-end gap-1"><SchemeRowMenu hasDocument={!!s.documentUrl} onInfo={() => setInfoFor(s)} onDoc={() => setDocFor(s)} onShare={() => void shareScheme(s)} onEdit={() => setEditing(s)} onDelete={() => setDeleting(s)} />{s.status === "OPEN" && <Button variant="ghost" size="sm" onClick={() => setClosing(s)} title="Close scheme" disabled={close.isPending}><Unlock className="h-4 w-4" /></Button>}{s.status === "CLOSED" && <Button variant="ghost" size="sm" onClick={() => setReopening(s)} title={isExpired(s) ? "Closed (period expired) — reopening requires extending the end date" : "Closed — click to reopen"} disabled={reopen.isPending}><Lock className="h-4 w-4" /></Button>}</div></TableCell>}</TableRow>)}</TableBody></Table></div>}
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
    {/* ⋮ menu dialogs — Info / View Document / Share reuse the shared Planned Scheme components verbatim. */}
    {infoFor && <SchemeInfoDialog scheme={toRunningScheme(infoFor)} onClose={() => setInfoFor(null)} />}
    {docFor && <SchemeDocumentDialog scheme={toRunningScheme(docFor)} onClose={() => setDocFor(null)} />}
    {shareFor && <SchemeShareDialog scheme={toRunningScheme(shareFor)} onClose={() => setShareFor(null)} />}
    {deleting && <DeleteSchemeDialog schemeId={deleting.id} schemeName={deleting.schemeName} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); invalidate(); }} />}
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
  const [maxExtDays, setMaxExtDays] = useState(scheme?.maxExtensionDays != null ? String(scheme.maxExtensionDays) : "0");
  const [maxExtAttempts, setMaxExtAttempts] = useState(scheme?.maxExtensionAttempts != null ? String(scheme.maxExtensionAttempts) : "0");
  const [documentUrl, setDocumentUrl] = useState(scheme?.documentUrl ?? "");
  const [installments, setInstallments] = useState<Installment[]>(scheme?.installments ?? []);
  const [error, setError] = useState<string | null>(null);

  // ---- Scheme Requirement (Phase 5). Belongs to the SCHEME, not to dealers. Defaults to None so existing
  // schemes stay installment-only. qty/value are kept as strings while editing (empty = not entered). ----
  type ReqRow = { productId: string; requiredQty: string; requiredValue: string };
  const [reqType, setReqType] = useState<ReqType>(scheme?.requirementType ?? "NONE");
  const [valueMode, setValueMode] = useState<ValueMode>(scheme?.valueMode ?? "INDIVIDUAL");
  const [combinedValue, setCombinedValue] = useState(scheme?.combinedRequiredValue != null ? String(scheme.combinedRequiredValue) : "");
  const [reqRows, setReqRows] = useState<ReqRow[]>(
    scheme?.requirementProducts?.map((p) => ({ productId: p.productId, requiredQty: p.requiredQty != null ? String(p.requiredQty) : "", requiredValue: p.requiredValue != null ? String(p.requiredValue) : "" })) ?? [],
  );
  const { data: productData } = useQuery<{ products: ProductOption[] }>({ queryKey: ["scheme-req-products"], queryFn: () => api.get("/api/products/master") });
  const productOptions = productData?.products ?? [];
  const productName = (id: string) => productOptions.find((p) => p.productId === id)?.name ?? "(unknown product)";
  const usedProductIds = new Set(reqRows.map((r) => r.productId));
  const availableProducts = productOptions.filter((p) => !usedProductIds.has(p.productId));

  const addReqRow = () => { const first = availableProducts[0]; if (!first) return; setReqRows((rows) => [...rows, { productId: first.productId, requiredQty: "", requiredValue: "" }]); };
  const updateReqRow = (idx: number, patch: Partial<ReqRow>) => setReqRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeReqRow = (idx: number) => setReqRows((rows) => rows.filter((_, i) => i !== idx));
  // Products still selectable for a given row = the ones not used elsewhere, plus the row's own current pick.
  const optionsForRow = (currentId: string) => productOptions.filter((p) => p.productId === currentId || !usedProductIds.has(p.productId));

  // Build the shared requirement shape (validation + persistence use the SAME normalizer contract).
  const requirementInput = () => ({
    requirementType: reqType,
    valueMode: reqType === "VALUE_BASED" ? valueMode : null,
    combinedRequiredValue: reqType === "VALUE_BASED" && valueMode === "COMBINED" ? (combinedValue === "" ? null : Number(combinedValue)) : null,
    products: reqType === "NONE" ? [] : reqRows.map((r) => ({
      productId: r.productId,
      requiredQty: reqType === "PRODUCT_BASED" ? (r.requiredQty === "" ? null : Number(r.requiredQty)) : null,
      requiredValue: reqType === "VALUE_BASED" && valueMode === "INDIVIDUAL" ? (r.requiredValue === "" ? null : Number(r.requiredValue)) : null,
    })),
  });
  const requirementErrors = validateSchemeRequirement(requirementInput());
  const requirementValid = requirementErrors.length === 0;

  // Requirement section labels (admin-customizable via the Labels page).
  const L = {
    section: useLabel("scheme_master.requirement.section"),
    type: useLabel("scheme_master.requirement.type"),
    typeNone: useLabel("scheme_master.requirement.type.none"),
    typeProduct: useLabel("scheme_master.requirement.type.product"),
    typeValue: useLabel("scheme_master.requirement.type.value"),
    valueMode: useLabel("scheme_master.requirement.value_mode"),
    modeIndividual: useLabel("scheme_master.requirement.value_mode.individual"),
    modeCombined: useLabel("scheme_master.requirement.value_mode.combined"),
    combinedValue: useLabel("scheme_master.requirement.combined_value"),
    applicableProducts: useLabel("scheme_master.requirement.applicable_products"),
    addProduct: useLabel("scheme_master.requirement.add_product"),
    colProduct: useLabel("scheme_master.requirement.col.product"),
    colQty: useLabel("scheme_master.requirement.col.required_qty"),
    colValue: useLabel("scheme_master.requirement.col.required_value"),
  };
  // Centrally-editable Scheme Master FORM labels (Admin → Labels).
  const FL = {
    createTitle: useLabel("scheme_master.form.create_title"),
    editTitle: useLabel("scheme_master.form.edit_title"),
    cancel: useLabel("scheme_master.form.cancel"),
    saveScheme: useLabel("scheme_master.form.save_scheme"),
    saveChanges: useLabel("scheme_master.form.save_changes"),
    schemeName: useLabel("scheme_master.form.scheme_name"),
    applicableStates: useLabel("scheme_master.form.applicable_states"),
    perpetual: useLabel("scheme_master.form.perpetual"),
    schemeStart: useLabel("scheme_master.form.scheme_start"),
    schemeEnd: useLabel("scheme_master.form.scheme_end"),
    lastBookingDate: useLabel("scheme_master.form.last_booking_date"),
    bookingAmount: useLabel("scheme_master.form.booking_amount"),
    valueWithoutGst: useLabel("scheme_master.form.value_without_gst"),
    valueWithGst: useLabel("scheme_master.form.value_with_gst"),
    schemeBenefit: useLabel("scheme_master.form.scheme_benefit"),
    allowMultiple: useLabel("scheme_master.form.allow_multiple"),
    maxExtDays: useLabel("scheme_master.form.max_extension_days"),
    maxExtAttempts: useLabel("scheme_master.form.max_extension_attempts"),
    benefitDetails: useLabel("scheme_master.form.benefit_details"),
    otherBenefitDetails: useLabel("scheme_master.form.other_benefit_details"),
    installmentBuilder: useLabel("scheme_master.form.installment_builder"),
    noOfInstallments: useLabel("scheme_master.form.no_of_installments"),
    calcType: useLabel("scheme_master.form.calculation_type"),
    colPercentage: useLabel("scheme_master.form.col_percentage"),
    colAmount: useLabel("scheme_master.form.col_amount"),
    daysAfterBilling: useLabel("scheme_master.form.days_after_billing"),
    schemeDocument: useLabel("scheme_master.form.scheme_document"),
  };

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

  const payload = () => ({ schemeName: name, stateIds, isPerpetual, startDate: isPerpetual ? null : startDate, endDate: isPerpetual ? null : endDate, bookingLastDate: isPerpetual ? null : bookingLastDate, schemeValueWithoutGST: valueWithoutGST, schemeValueWithGST: valueWithGST, bookingAmount: bookingAmount === "" ? null : bookingAmount, schemeBenefit: benefit, benefitDetails: benefit === "OTHER" ? benefitDetails : null, otherBenefitDetails: otherBenefitDetails.trim() || null, allowMultipleSchemes: multiple, maxExtensionDays: Number(maxExtDays) || 0, maxExtensionAttempts: Number(maxExtAttempts) || 0, documentUrl: documentUrl || null, installments: installments.map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: Number(r.value) || 0, daysAfterBillingDate: Number(r.daysAfterBillingDate) || 0 })), ...(() => { const req = requirementInput(); return { requirementType: req.requirementType, valueMode: req.valueMode, combinedRequiredValue: req.combinedRequiredValue, requirementProducts: req.products }; })() });
  const save = useMutation({ mutationFn: () => scheme ? api.patch(`/api/schemes/${scheme.id}`, payload()) : api.post("/api/schemes", payload()), onSuccess: onSaved, onError: (e) => setError((e as Error).message) });
  const upload = (file?: File) => { if (!file) return; if (file.size > 3_500_000) { setError("Document must be smaller than 3.5 MB"); return; } const reader = new FileReader(); reader.onload = () => setDocumentUrl(String(reader.result)); reader.readAsDataURL(file); };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{scheme ? FL.editTitle : FL.createTitle}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>{FL.schemeName} *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>{FL.applicableStates} *</Label><div className="grid grid-cols-2 gap-2 rounded-md border p-3">{states.map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stateIds.includes(s.id)} onChange={() => setStateIds((ids) => ids.includes(s.id) ? ids.filter((id) => id !== s.id) : [...ids, s.id])} />{s.name}</label>)}</div></div>
          <label className="flex items-center gap-2 rounded-md border p-3 text-sm font-medium"><input type="checkbox" checked={isPerpetual} onChange={(e) => setIsPerpetual(e.target.checked)} />{FL.perpetual}</label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>{FL.schemeStart} {!isPerpetual && "*"}</Label><Input disabled={isPerpetual} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>{FL.schemeEnd} {!isPerpetual && "*"}</Label><Input disabled={isPerpetual} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>{FL.lastBookingDate} {!isPerpetual && "*"}</Label><Input disabled={isPerpetual} type="date" value={bookingLastDate} onChange={(e) => setBookingLastDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>{FL.bookingAmount}</Label><Input type="number" min="0" value={bookingAmount} onChange={(e) => setBookingAmount(e.target.value)} placeholder="Optional" /></div>
            <div className="space-y-1.5"><Label>{FL.valueWithoutGst} *</Label><Input type="number" min="0" value={valueWithoutGST} onChange={(e) => setValueWithoutGST(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>{FL.valueWithGst} *</Label><Input type="number" min="0" value={valueWithGST} onChange={(e) => setValueWithGST(e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>{FL.schemeBenefit} *</Label><NativeSelect value={benefit} onChange={(e) => setBenefit(e.target.value as Benefit)} options={Object.entries(benefits).map(([value, label]) => ({ value, label }))} /></div>
            <div className="space-y-1.5"><Label>{FL.allowMultiple}</Label><NativeSelect value={multiple ? "yes" : "no"} onChange={(e) => setMultiple(e.target.value === "yes")} options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {/* Conversion Date Extension — set both > 0 to allow SOs to extend the planned conversion date. */}
            <div className="space-y-1.5"><Label>{FL.maxExtDays}</Label><Input type="number" min="0" value={maxExtDays} onChange={(e) => setMaxExtDays(e.target.value)} placeholder="0 = no extension" /></div>
            <div className="space-y-1.5"><Label>{FL.maxExtAttempts}</Label><Input type="number" min="0" value={maxExtAttempts} onChange={(e) => setMaxExtAttempts(e.target.value)} placeholder="0 = no extension" /></div>
          </div>
          {benefit === "OTHER" && <div className="space-y-1.5"><Label>{FL.benefitDetails} *</Label><Input value={benefitDetails} onChange={(e) => setBenefitDetails(e.target.value)} placeholder="e.g. Special Product Gift" /></div>}
          <div className="space-y-1.5"><Label>{FL.otherBenefitDetails}</Label><Input value={otherBenefitDetails} onChange={(e) => setOtherBenefitDetails(e.target.value)} placeholder="Optional additional notes" /></div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-semibold">{FL.installmentBuilder}</Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{FL.noOfInstallments}</span>
                <NativeSelect className="w-20" value={String(installments.length)} onChange={(e) => setCount(Number(e.target.value))} options={Array.from({ length: 11 }, (_, i) => ({ value: String(i), label: String(i) }))} />
              </div>
            </div>
            {installments.length > 0 && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{FL.calcType}</span>
                  <NativeSelect className="w-40" value={calcType} onChange={(e) => setAllCalc(e.target.value as CalcType)} options={[{ value: "PERCENTAGE", label: "Percentage" }, { value: "FIXED_AMOUNT", label: "Fixed Amount" }]} />
                </div>
                <div className="overflow-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead className="w-12">#</TableHead><TableHead>{calcType === "PERCENTAGE" ? FL.colPercentage : FL.colAmount}</TableHead><TableHead>{FL.daysAfterBilling}</TableHead></TableRow></TableHeader>
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

          {/* ---- Scheme Requirement (Phase 5). Requirement belongs to the scheme; achievement is computed
                elsewhere (Phase 4 engine). This section only defines what the scheme requires. ---- */}
          <div className="space-y-3 rounded-md border p-3">
            <Label className="text-sm font-semibold">{L.section}</Label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{L.type}</Label>
                <NativeSelect value={reqType} onChange={(e) => setReqType(e.target.value as ReqType)} options={[{ value: "NONE", label: L.typeNone }, { value: "PRODUCT_BASED", label: L.typeProduct }, { value: "VALUE_BASED", label: L.typeValue }]} />
              </div>
              {reqType === "VALUE_BASED" && (
                <div className="space-y-1.5">
                  <Label>{L.valueMode}</Label>
                  <NativeSelect value={valueMode} onChange={(e) => setValueMode(e.target.value as ValueMode)} options={[{ value: "INDIVIDUAL", label: L.modeIndividual }, { value: "COMBINED", label: L.modeCombined }]} />
                </div>
              )}
            </div>

            {reqType === "VALUE_BASED" && valueMode === "COMBINED" && (
              <div className="space-y-1.5">
                <Label>{L.combinedValue} *</Label>
                <Input type="number" min="0" value={combinedValue} onChange={(e) => setCombinedValue(e.target.value)} placeholder="Total value across the products below" />
              </div>
            )}

            {reqType !== "NONE" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-xs font-medium text-muted-foreground">{reqType === "VALUE_BASED" && valueMode === "COMBINED" ? L.applicableProducts : L.colProduct}</Label>
                  <Button type="button" variant="outline" size="sm" disabled={availableProducts.length === 0} onClick={addReqRow}><Plus className="h-3 w-3" /> {L.addProduct}</Button>
                </div>
                {reqRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No products added yet.</p>
                ) : (
                  <div className="overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{L.colProduct}</TableHead>
                          {reqType === "PRODUCT_BASED" && <TableHead className="w-40">{L.colQty}</TableHead>}
                          {reqType === "VALUE_BASED" && valueMode === "INDIVIDUAL" && <TableHead className="w-40">{L.colValue}</TableHead>}
                          <TableHead className="w-12" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {reqRows.map((r, i) => (
                          <TableRow key={i}>
                            <TableCell>
                              <NativeSelect value={r.productId} onChange={(e) => updateReqRow(i, { productId: e.target.value })} options={optionsForRow(r.productId).map((p) => ({ value: p.productId, label: p.isActive ? p.name : `${p.name} (inactive)` }))} />
                              {!productOptions.some((p) => p.productId === r.productId) && <p className="mt-1 text-xs text-muted-foreground">{productName(r.productId)}</p>}
                            </TableCell>
                            {reqType === "PRODUCT_BASED" && <TableCell><Input type="number" min="0" step="any" value={r.requiredQty} onChange={(e) => updateReqRow(i, { requiredQty: e.target.value })} placeholder="Qty" /></TableCell>}
                            {reqType === "VALUE_BASED" && valueMode === "INDIVIDUAL" && <TableCell><Input type="number" min="0" step="any" value={r.requiredValue} onChange={(e) => updateReqRow(i, { requiredValue: e.target.value })} placeholder="Value" /></TableCell>}
                            <TableCell><Button type="button" variant="ghost" size="sm" onClick={() => removeReqRow(i)} title="Remove"><X className="h-3 w-3" /></Button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {!requirementValid && reqRows.length > 0 && <p className="text-xs text-destructive">{requirementErrors[0]}</p>}
              </div>
            )}
          </div>

          <div className="space-y-1.5"><Label>{FL.schemeDocument}</Label><Input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,image/*" onChange={(e) => upload(e.target.files?.[0])} />{documentUrl && <div className="flex items-center gap-2 text-xs text-muted-foreground"><FileText className="h-4 w-4" />Document attached <Button variant="ghost" size="sm" onClick={() => setDocumentUrl("")}><X className="h-3 w-3" /></Button></div>}</div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{FL.cancel}</Button>
          <Button disabled={!name.trim() || !stateIds.length || (!isPerpetual && (!startDate || !endDate || !bookingLastDate)) || valueWithoutGST === "" || valueWithGST === "" || (benefit === "OTHER" && !benefitDetails.trim()) || !installValid || !requirementValid || save.isPending} onClick={() => { setError(null); save.mutate(); }}>{scheme ? FL.saveChanges : FL.saveScheme}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
