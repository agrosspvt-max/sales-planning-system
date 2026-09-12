"use client";

import { useState, type ReactNode } from "react";
import { FileText, Lock, Unlock, Plus, X, MoreVertical, Info, Share2, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatSchemeDate as formatDate, formatCurrency, cn } from "@/lib/utils";
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
import { validateMultipleOptions } from "@/lib/scheme-options";
import { computeInstallmentAmounts, bookingExceedsFinalInstallment, installmentValueColumns } from "@/lib/scheme-installments";
import { SchemeDateInput, FormattedNumberInput } from "./scheme-form-inputs";
import { SchemeDetailDialog } from "./scheme-detail-dialog";
import { EnrolledSchemesView } from "./scheme-enrolled-view";
// Reuse the EXACT Info / View Document / Share dialogs + helpers from the Planned Scheme (Create Plan) menu,
// so both menus stay identical. The Scheme Master row is adapted to the RunningScheme shape they expect.
import { SchemeInfoDialog, SchemeDocumentDialog, SchemeShareDialog, schemeShareText, schemeDocumentFile, schemeValueText, type RunningScheme } from "./scheme-create-plan";

/** A non-perpetual scheme whose end date has already passed is EXPIRED — auto-closed, not reopenable. */
const isExpired = (s: Scheme) => !s.isPerpetual && !!s.endDate && new Date(s.endDate) < new Date();

type Benefit = "DOMESTIC_TOUR" | "DOMESTIC_COUPLE_TOUR" | "FOREIGN_TOUR" | "CREDIT_NOTE" | "OTHER";
type BenefitChoice = Benefit | "SPECIAL_GIFT" | "GOLD_SILVER";
type CalcType = "PERCENTAGE" | "FIXED_AMOUNT";
type Installment = { installmentNumber: number; calculationType: CalcType; value: number; daysAfterBillingDate: number };
type State = { id: string; name: string };
type ReqType = "NONE" | "PRODUCT_BASED" | "VALUE_BASED";
type ValueMode = "INDIVIDUAL" | "COMBINED";
type RequirementProduct = { productId: string; requiredQty: number | null; requiredValue: number | null };
type Structure = "FIXED" | "MULTIPLE_OPTIONS";
type OptionAchievementType = "QUANTITY_BASED" | "VALUE_BASED";
type SchemeOption = { bookingAmount?: number | null; id?: string; label: string | null; target: number | null; valueWithoutGST: number; valueWithGST: number; isActive: boolean };
type Scheme = { installmentBalance?: boolean; id: string; schemeName: string; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null; schemeValueWithoutGST: number | null; schemeValueWithGST: number | null; bookingAmount: number | null; schemeBenefit: Benefit; benefitDetails: string | null; otherBenefitDetails: string | null; allowMultipleSchemes: boolean; maxExtensionDays: number; maxExtensionAttempts: number; prePlacementMaxDays?: number; documentUrl: string | null; status: "OPEN" | "CLOSED"; states: State[]; installments: Installment[]; requirementType?: ReqType; valueMode?: ValueMode | null; combinedRequiredValue?: number | null; requirementProducts?: RequirementProduct[]; structure?: Structure; optionAchievementType?: OptionAchievementType | null; options?: SchemeOption[]; eligibleProductIds?: string[] };
type ProductOption = { productId: string; name: string; isActive: boolean };
const benefits: Record<Exclude<Benefit, "DOMESTIC_COUPLE_TOUR">, string> = { DOMESTIC_TOUR: "Domestic Tour", FOREIGN_TOUR: "Foreign Tour", CREDIT_NOTE: "Credit Note", OTHER: "Other" };
const specialBenefitDetails: Record<Extract<BenefitChoice, "SPECIAL_GIFT" | "GOLD_SILVER">, string> = { SPECIAL_GIFT: "Special Gift", GOLD_SILVER: "Gold / Silver" };
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
  structure: s.structure ?? "FIXED", optionAchievementType: s.optionAchievementType ?? null,
  options: (s.options ?? []).map((o) => ({ id: o.id ?? "", label: o.label, target: o.target, valueWithoutGST: o.valueWithoutGST, valueWithGST: o.valueWithGST, isActive: o.isActive })),
  eligibleProductIds: s.eligibleProductIds ?? [],
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
    {hideList ? null : !hideViewToggle && view === "enrolled" ? <EnrolledSchemesView /> : <div className="overflow-auto rounded-lg border bg-background"><Table stickyFirstColumn><TableHeader><TableRow><TableHead>{ML.colName}</TableHead><TableHead>{ML.colStates}</TableHead><TableHead>{ML.colPeriod}</TableHead><TableHead>{ML.colLastBooking}</TableHead><TableHead className="text-right">{ML.colWithoutGst}</TableHead><TableHead className="text-right">{ML.colWithGst}</TableHead><TableHead>{ML.colBenefit}</TableHead><TableHead>{ML.colStatus}</TableHead>{canManage && <TableHead className="text-right">{ML.colActions}</TableHead>}</TableRow></TableHeader><TableBody>{isLoading ? <TableRow><TableCell colSpan={canManage ? 9 : 8}><Skeleton className="h-7 w-full" /></TableCell></TableRow> : !data?.length ? <TableRow><TableCell colSpan={canManage ? 9 : 8} className="py-10 text-center text-muted-foreground">No schemes found.</TableCell></TableRow> : data.map((s) => <TableRow key={s.id}><TableCell className="font-medium"><button type="button" className="text-left text-primary hover:underline" onClick={() => setDetail(s)} title="View dealer plans">{s.schemeName}</button>{s.documentUrl && <a href={s.documentUrl} target="_blank" rel="noreferrer" className="ml-2 inline-block text-primary" title="Open scheme document"><FileText className="h-4 w-4" /></a>}</TableCell><TableCell>{s.states.map((x) => x.name).join(", ")}</TableCell><TableCell>{s.isPerpetual ? "Perpetual" : `${formatDate(s.startDate!)} – ${formatDate(s.endDate!)}`}</TableCell><TableCell>{s.isPerpetual ? "—" : formatDate(s.bookingLastDate!)}</TableCell><TableCell className="text-right tabular-nums">{schemeValueText(s.schemeValueWithoutGST)}</TableCell><TableCell className="text-right tabular-nums">{schemeValueText(s.schemeValueWithGST)}</TableCell><TableCell>{benefits[s.schemeBenefit as Exclude<Benefit, "DOMESTIC_COUPLE_TOUR">] ?? "Domestic Couple Tour"}{s.benefitDetails ? ` · ${s.benefitDetails}` : ""}</TableCell><TableCell><Badge variant={s.status === "OPEN" ? "success" : "muted"}>{s.status}</Badge></TableCell>{canManage && <TableCell className="text-right"><div className="flex items-center justify-end gap-1"><SchemeRowMenu hasDocument={!!s.documentUrl} onInfo={() => setInfoFor(s)} onDoc={() => setDocFor(s)} onShare={() => void shareScheme(s)} onEdit={() => setEditing(s)} onDelete={() => setDeleting(s)} />{s.status === "OPEN" && <Button variant="ghost" size="sm" onClick={() => setClosing(s)} title="Close scheme" disabled={close.isPending}><Unlock className="h-4 w-4" /></Button>}{s.status === "CLOSED" && <Button variant="ghost" size="sm" onClick={() => setReopening(s)} title={isExpired(s) ? "Closed (period expired) — reopening requires extending the end date" : "Closed — click to reopen"} disabled={reopen.isPending}><Lock className="h-4 w-4" /></Button>}</div></TableCell>}</TableRow>)}</TableBody></Table></div>}
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

/**
 * Shared product-row selector — the SAME "Select Product" dropdown + "+ Add Product" pattern the Fixed
 * requirement products use, so Fixed and Multiple Options pick products identically. Rows may hold an empty
 * pending selection ("Select Product"); the component publishes the unique, non-empty ids to the parent, so
 * no product is auto-selected, duplicates are prevented, and saved products load unchanged in edit mode.
 * Used for the Multiple Options eligible-product pool — selection semantics (a set of ids) are unchanged.
 */
function EligibleProductRows({ products, value, onChange, addLabel, productName, maxProducts }: { products: ProductOption[]; value: string[]; onChange: (ids: string[]) => void; addLabel: string; productName: (id: string) => string; maxProducts?: number }) {
  const [rows, setRows] = useState<string[]>(value.length ? value : [""]);
  const publish = (next: string[]) => { setRows(next); onChange([...new Set(next.filter((x) => x !== ""))]); };
  const used = new Set(rows.filter((x) => x !== ""));
  const optionsFor = (cur: string) => products.filter((p) => p.productId === cur || !used.has(p.productId));
  return (
    <div className="space-y-2">
      {rows.map((id, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex-1">
            <NativeSelect value={id} onChange={(e) => publish(rows.map((r, idx) => (idx === i ? e.target.value : r)))} options={[{ value: "", label: "Select Product" }, ...optionsFor(id).map((p) => ({ value: p.productId, label: p.isActive ? p.name : `${p.name} (inactive)` }))]} />
            {id !== "" && !products.some((p) => p.productId === id) && <p className="mt-1 text-xs text-muted-foreground">{productName(id)}</p>}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => publish(rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [""])} title="Remove"><X className="h-3 w-3" /></Button>
        </div>
      ))}
      {(maxProducts == null || rows.length < maxProducts) && <Button type="button" variant="outline" size="sm" onClick={() => publish([...rows, ""])}><Plus className="h-3 w-3" /> {addLabel}</Button>}
    </div>
  );
}

/** One bordered, content-sized section card for the Create/Edit Scheme form. Same visual language across
 *  all sections (border, radius, padding, header typography). No fixed heights — grows with its content. */
function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    // Elevated navy surface (bg-card, ~13% L) sitting on the darker modal (bg-background, ~10% L), with the
    // theme's subtle blue-gray border — the reference's layered section-card look, all from existing tokens.
    <section className="space-y-3 rounded-md border bg-card p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function SchemeDialog({ scheme, states, onClose, onSaved }: { scheme?: Scheme; states: State[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(scheme?.schemeName ?? "");
  const [stateIds, setStateIds] = useState<string[]>(scheme?.states.map((s) => s.id) ?? []);
  // Perpetual is no longer editable in the UI (control removed); the value is preserved from the loaded
  // scheme purely so save payload + backend behaviour for any existing perpetual scheme stay unchanged.
  const [isPerpetual] = useState(scheme?.isPerpetual ?? false);
  const [startDate, setStartDate] = useState(scheme ? toDateInput(scheme.startDate) : "");
  const [endDate, setEndDate] = useState(scheme ? toDateInput(scheme.endDate) : "");
  const [bookingLastDate, setBookingLastDate] = useState(scheme ? toDateInput(scheme.bookingLastDate) : "");
  const [valueWithoutGST, setValueWithoutGST] = useState(scheme ? String(scheme.schemeValueWithoutGST) : "");
  const [valueWithGST, setValueWithGST] = useState(scheme ? String(scheme.schemeValueWithGST) : "");
  const [bookingAmount, setBookingAmount] = useState(scheme?.bookingAmount != null ? String(scheme.bookingAmount) : "");
  // Create starts UNSELECTED ("Select Scheme Benefit"); Edit loads the saved benefit.
  const [benefit, setBenefit] = useState<Benefit | "">(scheme?.schemeBenefit ?? "");
  const [benefitDetails, setBenefitDetails] = useState(scheme?.benefitDetails ?? "");
  const [otherBenefitDetails, setOtherBenefitDetails] = useState(scheme?.otherBenefitDetails ?? "");
  const [multiple, setMultiple] = useState<"" | "yes" | "no">(scheme ? (scheme.allowMultipleSchemes ? "yes" : "no") : "");
  // Create starts EMPTY (not "0"); Edit loads the saved value. Blank saves as 0 via `Number(x) || 0` (unchanged).
  const [maxExtDays, setMaxExtDays] = useState(scheme?.maxExtensionDays != null ? String(scheme.maxExtensionDays) : "");
  const [maxExtAttempts, setMaxExtAttempts] = useState(scheme?.maxExtensionAttempts != null ? String(scheme.maxExtensionAttempts) : "");
  const [prePlacementMaxDays, setPrePlacementMaxDays] = useState(scheme?.prePlacementMaxDays != null ? String(scheme.prePlacementMaxDays) : "");
  const [documentUrl, setDocumentUrl] = useState(scheme?.documentUrl ?? "");
  const [installmentBalance, setInstallmentBalance] = useState(scheme?.installmentBalance ?? !scheme);
  const [installments, setInstallments] = useState<Installment[]>(scheme?.installments ?? []);
  const [installmentMode, setInstallmentMode] = useState<CalcType | "">(scheme?.installments[0]?.calculationType ?? "");
  const [error, setError] = useState<string | null>(null);
  const standardExtensionAttempts = new Set(["-1", "1", "2", "3", "4", "5"]);
  const preservedExtensionAttemptOption = scheme && maxExtAttempts !== "" && !standardExtensionAttempts.has(maxExtAttempts)
    ? [{ value: maxExtAttempts, label: maxExtAttempts === "0" ? "Disabled" : maxExtAttempts }]
    : [];

  // ---- Scheme Requirement (Phase 5). Belongs to the SCHEME, not to dealers. A real basis must be chosen;
  // qty/value are kept as strings while editing (empty = not entered). ----
  type ReqRow = { productId: string; requiredQty: string; requiredValue: string };
  const [reqType, setReqType] = useState<ReqType | "">(scheme?.requirementType === "NONE" ? "" : (scheme?.requirementType ?? ""));
  const [reqRows, setReqRows] = useState<ReqRow[]>(
    scheme?.requirementProducts?.map((p) => ({ productId: p.productId, requiredQty: p.requiredQty != null ? String(p.requiredQty) : "", requiredValue: p.requiredValue != null ? String(p.requiredValue) : "" })) ?? [],
  );
  const { data: productData } = useQuery<{ products: ProductOption[] }>({ queryKey: ["scheme-req-products"], queryFn: () => api.get("/api/products/master") });
  const productOptions = productData?.products ?? [];
  const productName = (id: string) => productOptions.find((p) => p.productId === id)?.name ?? "(unknown product)";
  const usedProductIds = new Set(reqRows.map((r) => r.productId));
  const availableProducts = productOptions.filter((p) => !usedProductIds.has(p.productId));

  // A new product row starts EMPTY — no product is auto-selected; the user must pick one ("Select Product").
  const emptyReqRow = (): ReqRow => ({ productId: "", requiredQty: "", requiredValue: "" });
  const addReqRow = () => setReqRows((rows) => [...rows, emptyReqRow()]);
  const updateReqRow = (idx: number, patch: Partial<ReqRow>) => setReqRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeReqRow = (idx: number) => setReqRows((rows) => rows.filter((_, i) => i !== idx));
  // Choosing a basis (Product/Value Based) shows ONE empty product row to start; existing rows are kept.
  const changeReqType = (t: ReqType | "") => { setReqType(t); if (t && t !== "NONE") setReqRows((rows) => (rows.length === 0 ? [emptyReqRow()] : rows)); };
  // Products still selectable for a given row = the ones not used elsewhere, plus the row's own current pick.
  const optionsForRow = (currentId: string) => productOptions.filter((p) => p.productId === currentId || !usedProductIds.has(p.productId));

  // Build the shared requirement shape (validation + persistence use the SAME normalizer contract).
  // Fixed + Value Based ALWAYS uses COMBINED (the Value Mode selector was removed): Scheme Value
  // (With GST) is also the combined required value, so the user enters the total only once. Preserve a
  // legacy stored target on an unchanged edit; changing the visible GST value makes it authoritative.
  const combinedRequiredValue = reqType !== "VALUE_BASED" || valueWithGST === ""
    ? null
    : scheme?.requirementType === "VALUE_BASED" && scheme.combinedRequiredValue != null && valueWithGST === String(scheme.schemeValueWithGST)
      ? scheme.combinedRequiredValue
      : Number(valueWithGST);
  const requirementInput = () => ({
    requirementType: (reqType || "NONE") as ReqType,
    valueMode: reqType === "VALUE_BASED" ? ("COMBINED" as ValueMode) : null,
    combinedRequiredValue,
    products: reqType === "NONE" ? [] : reqRows.map((r) => ({
      productId: r.productId,
      requiredQty: reqType === "PRODUCT_BASED" ? (r.requiredQty === "" ? null : Number(r.requiredQty)) : null,
      requiredValue: null, // Value Based is Combined → per-product values are never used
    })),
  });
  const requirementErrors = validateSchemeRequirement(requirementInput());
  const requirementValid = reqType !== "" && reqType !== "NONE" && requirementErrors.length === 0;

  // ---- Multiple Options (Phase 10). A scheme is FIXED (existing behaviour) or MULTIPLE_OPTIONS: an
  // achievement type + an eligible product pool + ≥1 option (label? + target + value pair). Scheme-level
  // value fields are unused for options (sent null); installment rules are shared across options. ----
  // Labels are retained for historical round-tripping, but are no longer editable.
  type OptRow = { bookingAmount: string; id?: string; label: string; target: string; valueWithoutGST: string; valueWithGST: string; isActive: boolean };
  const [structure, setStructure] = useState<Structure | "">(scheme?.structure ?? "");
  // Create starts UNSELECTED ("Select Achievement Type"); Edit loads the saved type.
  const [optAchType, setOptAchType] = useState<OptionAchievementType | "">(scheme?.optionAchievementType ?? "");
  const [eligibleIds, setEligibleIds] = useState<string[]>(scheme?.eligibleProductIds ?? []);
  const [optRows, setOptRows] = useState<OptRow[]>(
    scheme?.options?.map((o) => ({ bookingAmount: String(o.bookingAmount ?? scheme.bookingAmount ?? 0), id: o.id, label: o.label ?? "", target: o.target != null ? String(o.target) : "", valueWithoutGST: String(o.valueWithoutGST), valueWithGST: String(o.valueWithGST), isActive: o.isActive })) ?? [],
  );
  const addOptRow = () => setOptRows((r) => [...r, { bookingAmount: "", label: "", target: "", valueWithoutGST: "", valueWithGST: "", isActive: true }]);
  const updateOptRow = (i: number, patch: Partial<OptRow>) => setOptRows((r) => r.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeOptRow = (i: number) => setOptRows((r) => r.filter((_, idx) => idx !== i));
  const multipleOptionsInput = () => ({
    achievementType: optAchType as OptionAchievementType, // "" is caught by validateMultipleOptions (gates Save)
    eligibleProductIds: eligibleIds,
    options: optRows.map((o) => ({ label: o.label.trim() || null, target: optAchType === "QUANTITY_BASED" && o.target !== "" ? Number(o.target) : null, valueWithoutGST: o.valueWithoutGST === "" ? null : Number(o.valueWithoutGST), valueWithGST: o.valueWithGST === "" ? null : Number(o.valueWithGST) })),
  });
  const optionErrors = structure === "MULTIPLE_OPTIONS" ? validateMultipleOptions(multipleOptionsInput()) : [];
  const optionBookingsValid = optRows.length > 0 && optRows.every((option) => option.bookingAmount !== "" && Number(option.bookingAmount) >= 0);
  const optionsValid = optionErrors.length === 0 && optionBookingsValid;
  const isOptions = structure === "MULTIPLE_OPTIONS";
  const changeStructure = (s: Structure | "") => {
    setStructure(s);
    if (installmentMode === "FIXED_AMOUNT") setInstallmentBalance(s === "MULTIPLE_OPTIONS");
  };

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
    structure: useLabel("scheme_master.form.structure"),
    structureFixed: useLabel("scheme_master.form.structure.fixed"),
    structureOptions: useLabel("scheme_master.form.structure.options"),
    achievementType: useLabel("scheme_master.form.achievement_type"),
    achQuantity: useLabel("scheme_master.form.achievement_type.quantity"),
    achValue: useLabel("scheme_master.form.achievement_type.value"),
    eligibleProducts: useLabel("scheme_master.form.eligible_products"),
    noOfOptions: useLabel("scheme_master.form.no_of_options"),
    onlyMultiple: useLabel("scheme_master.form.only_multiple"),
    onlyFixed: useLabel("scheme_master.form.only_fixed"),
    optionsBuilder: useLabel("scheme_master.form.options_builder"),
    optColLabel: useLabel("scheme_master.form.option_col.label"),
    optColTarget: useLabel("scheme_master.form.option_col.target"),
    optColValueWithout: useLabel("scheme_master.form.option_col.value_without_gst"),
    optColValueWith: useLabel("scheme_master.form.option_col.value_with_gst"),
    optColActive: useLabel("scheme_master.form.option_col.active"),
    addOption: useLabel("scheme_master.form.add_option"),
    schemeBenefit: useLabel("scheme_master.form.scheme_benefit"),
    allowMultiple: useLabel("scheme_master.form.allow_multiple"),
    maxExtDays: useLabel("scheme_master.form.max_extension_days"),
    maxExtAttempts: useLabel("scheme_master.form.max_extension_attempts"),
    prePlacement: useLabel("scheme_master.form.pre_placement_max_days"),
    sectionBasic: useLabel("scheme_master.form.section.basic"),
    sectionDetails: useLabel("scheme_master.form.section.details"),
    sectionPayment: useLabel("scheme_master.form.section.payment"),
    sectionTimeline: useLabel("scheme_master.form.section.timeline"),
    sectionBenefit: useLabel("scheme_master.form.section.benefit"),
    sectionDocument: useLabel("scheme_master.form.section.document"),
    benefitDetails: useLabel("scheme_master.form.benefit_details"),
    otherBenefitDetails: useLabel("scheme_master.form.other_benefit_details"),
    installmentBuilder: useLabel("scheme_master.form.installment_builder"),
    colAmountDerived: useLabel("scheme_master.form.col_amount_derived"),
    bookingNote: useLabel("scheme_master.form.booking_note"),
    noOfInstallments: useLabel("scheme_master.form.no_of_installments"),
    calcType: useLabel("scheme_master.form.calculation_type"),
    colPercentage: useLabel("scheme_master.form.col_percentage"),
    colAmount: useLabel("scheme_master.form.col_amount"),
    daysAfterBilling: useLabel("scheme_master.form.days_after_billing"),
    schemeDocument: useLabel("scheme_master.form.scheme_document"),
  };

  const gstValue = Number(valueWithGST) || 0;
  const fixedGstValid = valueWithoutGST === "" || valueWithGST === "" || Math.round(Number(valueWithGST) * 100) >= Math.round(Number(valueWithoutGST) * 100);
  const calcType: CalcType = installmentMode || installments[0]?.calculationType || "PERCENTAGE";
  const round2 = (n: number) => Math.round(n * 100) / 100;
  // Booking Amount (scheme-level) is deducted from the FINAL installment by the shared calculator.
  const booking = Number(bookingAmount) || 0;
  // The FINAL installment auto-balances: its % (or amount) is the remainder after the earlier rows, so the
  // percentages always total 100% (or the amounts total the scheme value). Only the earlier rows are edited.
  const installTarget = calcType === "PERCENTAGE" ? 100 : gstValue;
  const nonFinalSum = installments.length > 0 ? installments.slice(0, -1).reduce((sum, r) => sum + (Number(r.value) || 0), 0) : 0;
  const finalValue = installments.length > 0
    ? isOptions && calcType === "FIXED_AMOUNT" ? 0 : round2(installTarget - nonFinalSum)
    : 0; // Options Amount stores a zero-valued Balance rule; each option derives its own final amount.
  // Effective rules = state with the final row overridden to the auto-balanced value. Persisted + shown.
  const effInstallments = installments.map((r, i) => (i === installments.length - 1 ? { ...r, value: finalValue } : r));
  const paymentColumns = installmentValueColumns({
    structure: (structure || "FIXED") as Structure, achievementType: optAchType, valueWithGST: gstValue, bookingAmount: booking,
    options: optRows.map(o => ({ target: o.target === "" ? null : Number(o.target), valueWithGST: Number(o.valueWithGST) || 0, bookingAmount: Number(o.bookingAmount) || 0 })),
  });
  const columnAmounts = paymentColumns.map(c => computeInstallmentAmounts(effInstallments, c.valueWithGST, c.bookingAmount, installmentBalance));
  const finalNegative = installments.length > 0 && finalValue < -1e-9;
  const bookingTooBig = paymentColumns.some((c, i) => (!isOptions || optRows[i].isActive) &&
    bookingExceedsFinalInstallment(effInstallments, c.valueWithGST, c.bookingAmount, installmentBalance));
  const installValid = installments.length === 0 || (!finalNegative && !bookingTooBig);

  const setCount = (n: number) => {
    if (n > 0 && scheme?.installments.length === 0 && installmentMode !== "FIXED_AMOUNT") setInstallmentBalance(true);
    setInstallments((prev) => {
      const type = installmentMode || prev[0]?.calculationType || "PERCENTAGE";
      return Array.from({ length: n }, (_, i) => prev[i] ?? { installmentNumber: i + 1, calculationType: type, value: 0, daysAfterBillingDate: 0 })
        .map((r, i) => ({ ...r, installmentNumber: i + 1 }));
    });
  };
  const updateRow = (idx: number, patch: Partial<Installment>) => setInstallments((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const setAllCalc = (t: CalcType | "") => {
    setInstallmentMode(t);
    if (!t) return;
    if (t === "FIXED_AMOUNT") setInstallmentBalance(isOptions);
    setInstallments((prev) => prev.map((r) => ({ ...r, calculationType: t })));
  };

  const payload = () => {
    const common = {
      schemeName: name, stateIds, isPerpetual, installmentBalance,
      startDate: isPerpetual ? null : startDate, endDate: isPerpetual ? null : endDate, bookingLastDate: isPerpetual ? null : bookingLastDate,
      bookingAmount: bookingAmount === "" ? null : bookingAmount, schemeBenefit: benefit, benefitDetails: benefit === "OTHER" ? benefitDetails : null,
      otherBenefitDetails: otherBenefitDetails.trim(), allowMultipleSchemes: multiple === "yes",
      maxExtensionDays: Number(maxExtDays) || 0, maxExtensionAttempts: Number(maxExtAttempts) || 0, prePlacementMaxDays: Number(prePlacementMaxDays) || 0, documentUrl: documentUrl || null,
      installments: effInstallments.map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: Number(r.value) || 0, daysAfterBillingDate: Number(r.daysAfterBillingDate) || 0 })),
      structure: structure as Structure,
    };
    if (isOptions) {
      // MULTIPLE_OPTIONS: no scheme-level value (null → "Per option"); requirement is replaced by the option pool.
      return {
        ...common,
        schemeValueWithoutGST: null, schemeValueWithGST: null,
        optionAchievementType: optAchType || null, eligibleProductIds: eligibleIds,
        options: optRows.map((o) => ({ bookingAmount: o.bookingAmount === "" ? null : Number(o.bookingAmount), id: o.id, label: o.label.trim() || null, target: optAchType === "QUANTITY_BASED" && o.target !== "" ? Number(o.target) : null, valueWithoutGST: o.valueWithoutGST === "" ? null : Number(o.valueWithoutGST), valueWithGST: o.valueWithGST === "" ? null : Number(o.valueWithGST), isActive: o.isActive })),
        requirementType: "NONE", valueMode: null, combinedRequiredValue: null, requirementProducts: [],
      };
    }
    const req = requirementInput();
    return {
      ...common,
      schemeValueWithoutGST: valueWithoutGST, schemeValueWithGST: valueWithGST,
      optionAchievementType: null, eligibleProductIds: [], options: [],
      requirementType: req.requirementType, valueMode: req.valueMode, combinedRequiredValue: req.combinedRequiredValue, requirementProducts: req.products,
    };
  };
  const save = useMutation({ mutationFn: () => scheme ? api.patch(`/api/schemes/${scheme.id}`, payload()) : api.post("/api/schemes", payload()), onSuccess: onSaved, onError: (e) => setError((e as Error).message) });
  const upload = (file?: File) => { if (!file) return; if (file.size > 3_500_000) { setError("Document must be smaller than 3.5 MB"); return; } const reader = new FileReader(); reader.onload = () => setDocumentUrl(String(reader.result)); reader.readAsDataURL(file); };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* Medium-wide, viewport-capped modal: header + footer stay put, only the form body scrolls vertically.
          `flex flex-col` (via tailwind-merge) replaces the base grid; width caps at ~896px (max-w-4xl) but
          never exceeds the viewport. ONE shared content width: single-field rows span the full body width,
          two-field rows split it 50/50 via `sm:grid-cols-2` — no per-field max-width caps — so every row and
          section (installment builder, options table, eligible-product picker) shares the same left/right edges. */}
      <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2.5rem)] max-w-4xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0"><DialogTitle>{scheme ? FL.editTitle : FL.createTitle}</DialogTitle></DialogHeader>
        {/* Body is content-sized: it may SHRINK and scroll when the form is genuinely taller than the
            viewport (min-h-0 + default flex-shrink), but it must NOT grow to fill the modal — no `flex-1`,
            so short forms stay compact and leave no empty vertical space. Footer stays pinned below. */}
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          {/* 1. BASIC SCHEME INFORMATION */}
          <FormSection title={FL.sectionBasic}>
            <div className="space-y-1.5"><Label>{FL.schemeName} *</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter scheme name" /></div>
            <div className="space-y-1.5"><Label>{FL.applicableStates} *</Label><div className="grid grid-cols-2 gap-2 rounded-md border p-3">{states.map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stateIds.includes(s.id)} onChange={() => setStateIds((ids) => ids.includes(s.id) ? ids.filter((id) => id !== s.id) : [...ids, s.id])} />{s.name}</label>)}</div></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* Phase 10: Fixed (one scheme value) vs Multiple Options (a pool + several option targets). */}
              <div className="space-y-1.5">
                <Label>{FL.structure} *</Label>
                <NativeSelect value={structure} onChange={(e) => changeStructure(e.target.value as Structure | "")} options={[{ value: "", label: "Select..." }, { value: "FIXED", label: FL.structureFixed }, { value: "MULTIPLE_OPTIONS", label: FL.structureOptions }]} />
              </div>
              <div className="space-y-1.5"><Label>{FL.allowMultiple} *</Label><NativeSelect value={multiple} onChange={(e) => setMultiple(e.target.value as "" | "yes" | "no")} options={[{ value: "", label: "Select..." }, { value: "no", label: "No" }, { value: "yes", label: "Yes" }]} /></div>
            </div>

          </FormSection>

          {/* 2. SCHEME DETAILS — Fixed: scheme values + requirement; Multiple Options: achievement type, eligible pool, options. */}
          <FormSection title={FL.sectionDetails}>
            {isOptions ? (
              <div className="space-y-3">
                {/* For Multiple Options, Scheme Basis is the achievement type (Quantity/Value Based). */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>{L.type} *</Label>
                    <NativeSelect value={optAchType} onChange={(e) => setOptAchType(e.target.value as OptionAchievementType | "")} options={[{ value: "", label: "Select..." }, { value: "QUANTITY_BASED", label: FL.achQuantity }, { value: "VALUE_BASED", label: FL.achValue }]} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">{FL.eligibleProducts} *</Label>
                  {/* SAME product-selection pattern as Fixed: "Select Product" dropdown rows + "+ Add Product". */}
                  <EligibleProductRows products={productOptions} value={eligibleIds} onChange={setEligibleIds} addLabel={L.addProduct} productName={productName} maxProducts={optAchType === "QUANTITY_BASED" ? 1 : undefined} />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">{FL.optionsBuilder} *</Label>
                  {optRows.length > 0 && (
                    <div className="overflow-x-auto">
                      <Table className={optAchType === "QUANTITY_BASED" ? "min-w-[640px]" : "min-w-[520px]"}>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-24">Option</TableHead>
                            {optAchType === "QUANTITY_BASED" && <TableHead className="w-32">{FL.optColTarget} (Qty) *</TableHead>}
                            <TableHead className="w-36">{FL.optColValueWithout} *</TableHead>
                            <TableHead className="w-36">{FL.optColValueWith} *</TableHead>
                            <TableHead className="w-16 text-center">{FL.optColActive} *</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {optRows.map((o, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-medium">Option {i + 1}</TableCell>
                              {optAchType === "QUANTITY_BASED" && <TableCell><FormattedNumberInput value={o.target} onValueChange={(target) => updateOptRow(i, { target })} placeholder="Enter quantity" /></TableCell>}
                              <TableCell><FormattedNumberInput value={o.valueWithoutGST} onValueChange={(valueWithoutGST) => updateOptRow(i, { valueWithoutGST })} placeholder="Enter amount" /></TableCell>
                              <TableCell><FormattedNumberInput value={o.valueWithGST} onValueChange={(valueWithGST) => updateOptRow(i, { valueWithGST })} placeholder="Enter amount" /></TableCell>
                              <TableCell><div className="flex items-center justify-center gap-1"><input type="checkbox" aria-label={`Option ${i + 1} active`} checked={o.isActive} onChange={(e) => updateOptRow(i, { isActive: e.target.checked })} /><Button type="button" variant="ghost" size="sm" onClick={() => removeOptRow(i)} title="Remove" aria-label={`Remove option ${i + 1}`}><X className="h-3 w-3" /></Button></div></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  {/* Add Option — wrapped in a block so it always sits on its OWN line below the "Options" label
                      (the label is inline), left aligned, whether or not any options have been added. */}
                  <div><Button type="button" variant="outline" size="sm" onClick={addOptRow}><Plus className="h-3 w-3" /> {FL.addOption}</Button></div>
                  {!optionsValid && optRows.length > 0 && <p className="text-xs text-destructive">{optionErrors[0] ?? "Booking Amount is required for every option."}</p>}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Scheme Basis + product requirement come FIRST in the required sequence (before the values).
                    No redundant inner section heading — the "SCHEME DETAILS" FormSection title already covers it. */}
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>{L.type} *</Label>
                      <NativeSelect value={reqType} onChange={(e) => changeReqType(e.target.value as ReqType | "")} options={[{ value: "", label: "Select..." }, { value: "PRODUCT_BASED", label: L.typeProduct }, { value: "VALUE_BASED", label: L.typeValue }]} />
                    </div>
                  </div>
                  {reqType !== "" && reqType !== "NONE" && (
                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-muted-foreground">{reqType === "VALUE_BASED" ? L.applicableProducts : L.colProduct} *</Label>
                      {reqRows.length > 0 && (
                        <div className="overflow-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>{L.colProduct} *</TableHead>
                                {reqType === "PRODUCT_BASED" && <TableHead className="w-40">{L.colQty} *</TableHead>}
                                <TableHead className="w-12" />
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {reqRows.map((r, i) => (
                                <TableRow key={i}>
                                  <TableCell>
                                    {/* No product is pre-selected — a new row starts on the "Select Product" placeholder. */}
                                    <NativeSelect value={r.productId} onChange={(e) => updateReqRow(i, { productId: e.target.value })} options={[{ value: "", label: "Select Product" }, ...optionsForRow(r.productId).map((p) => ({ value: p.productId, label: p.isActive ? p.name : `${p.name} (inactive)` }))]} />
                                    {r.productId !== "" && !productOptions.some((p) => p.productId === r.productId) && <p className="mt-1 text-xs text-muted-foreground">{productName(r.productId)}</p>}
                                  </TableCell>
                                  {reqType === "PRODUCT_BASED" && <TableCell><FormattedNumberInput value={r.requiredQty} onValueChange={(requiredQty) => updateReqRow(i, { requiredQty })} placeholder="Enter quantity" /></TableCell>}
                                  <TableCell><Button type="button" variant="ghost" size="sm" onClick={() => removeReqRow(i)} title="Remove"><X className="h-3 w-3" /></Button></TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                      {/* Add Product — left aligned, always BELOW the product rows (same interaction pattern as Multiple Options). */}
                      <Button type="button" variant="outline" size="sm" disabled={availableProducts.length === 0} onClick={addReqRow}><Plus className="h-3 w-3" /> {L.addProduct}</Button>
                      {!requirementValid && reqRows.length > 0 && <p className="text-xs text-destructive">{requirementErrors[0]}</p>}
                    </div>
                  )}
                </div>
                {/* Scheme Value pair — AFTER the Scheme Basis / product rows, per the required sequence. */}
                <div className="grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2">
                  <div className="space-y-1.5"><Label>{FL.valueWithoutGst} *</Label><FormattedNumberInput value={valueWithoutGST} onValueChange={setValueWithoutGST} placeholder="Enter amount" /></div>
                  <div className="space-y-1.5"><Label>{FL.valueWithGst} *</Label><FormattedNumberInput value={valueWithGST} onValueChange={setValueWithGST} placeholder="Enter amount" />{!fixedGstValid && <p className="text-xs text-destructive">Scheme Value (With GST) must be greater than or equal to Scheme Value (Without GST).</p>}</div>
                </div>
              </div>
            )}
            {/* Scheme Benefit + Other Benefit Details come LAST in Scheme Details (positions 5–6). Shared by
                both Fixed and Multiple Options; same fields, labels and behaviour — only the position changed. */}
            <div className="space-y-3">
              <div className="space-y-1.5"><Label>{FL.schemeBenefit} *</Label><NativeSelect value={benefit === "OTHER" && benefitDetails === specialBenefitDetails.SPECIAL_GIFT ? "SPECIAL_GIFT" : benefit === "OTHER" && benefitDetails === specialBenefitDetails.GOLD_SILVER ? "GOLD_SILVER" : benefit} onChange={(e) => { const selected = e.target.value as BenefitChoice | ""; if (selected === "SPECIAL_GIFT" || selected === "GOLD_SILVER") { setBenefit("OTHER"); setBenefitDetails(specialBenefitDetails[selected]); } else { setBenefit(selected as Benefit | ""); setBenefitDetails(""); } }} options={[{ value: "", label: "Select..." }, ...Object.entries(benefits).filter(([value]) => value !== "OTHER").map(([value, label]) => ({ value, label })), { value: "SPECIAL_GIFT", label: specialBenefitDetails.SPECIAL_GIFT }, { value: "GOLD_SILVER", label: specialBenefitDetails.GOLD_SILVER }, { value: "OTHER", label: benefits.OTHER }]} /></div>
              {benefit === "OTHER" && benefitDetails !== specialBenefitDetails.SPECIAL_GIFT && benefitDetails !== specialBenefitDetails.GOLD_SILVER && <div className="space-y-1.5"><Label>{FL.benefitDetails} *</Label><Input value={benefitDetails} onChange={(e) => setBenefitDetails(e.target.value)} placeholder="e.g. Special Product Gift" /></div>}
            </div>
            <div className="space-y-1.5"><Label>{FL.otherBenefitDetails} *</Label><Input value={otherBenefitDetails} onChange={(e) => setOtherBenefitDetails(e.target.value)} placeholder="Enter additional benefit details" /></div>
          </FormSection>

          {/* Booking is separate from the actual installment rules and has no billing-day offset. */}
          <FormSection title={FL.sectionPayment}>
            <div className="space-y-3 rounded-md border p-3">
              <Label className="text-sm font-semibold">{FL.installmentBuilder}</Label>
              <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{FL.noOfInstallments} *</Label>
                  <NativeSelect value={installments.length === 0 ? "" : String(installments.length)} onChange={(e) => setCount(Number(e.target.value) || 0)} options={[{ value: "", label: "Select…" }, ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `Booking Amount + ${i + 1}` }))]} />
                </div>
                <div className="space-y-1.5">
                  <Label>Installment Mode *</Label>
                  <NativeSelect value={installmentMode} onChange={(e) => setAllCalc(e.target.value as CalcType | "")} options={[{ value: "", label: "Select..." }, { value: "PERCENTAGE", label: "Percentage" }, { value: "FIXED_AMOUNT", label: "Amount" }]} />
                </div>
              </div>
              <Table className={cn(
                "border border-border/80 [&_td]:border-b [&_td]:border-r [&_td]:border-border/70 [&_th]:border-b [&_th]:border-r [&_th]:border-border/70 [&_td:last-child]:border-r-0 [&_th:last-child]:border-r-0 [&_tbody_tr:last-child_td]:border-b-0",
                isOptions ? "min-w-max" : "min-w-[640px]",
              )}>
                  <TableHeader><TableRow>
                    <TableHead className="min-w-44">Scheme Payment</TableHead>
                    {calcType === "PERCENTAGE" && <TableHead className="min-w-40">Payment Details</TableHead>}
                    {paymentColumns.map((c, i) => <TableHead key={i} className="min-w-40 text-right">{c.header}</TableHead>)}
                    <TableHead className="min-w-44">{FL.daysAfterBilling} *</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-medium">Booking Amount *</TableCell>
                      {calcType === "PERCENTAGE" && <TableCell className="text-muted-foreground">As per scheme</TableCell>}
                      {paymentColumns.map((c, i) => <TableCell key={i}><FormattedNumberInput integerOnly={isOptions} aria-label={`Booking Amount — ${c.header}`} className="text-right" value={isOptions ? optRows[i].bookingAmount : bookingAmount} onValueChange={value => isOptions ? updateOptRow(i, { bookingAmount: value }) : setBookingAmount(value)} placeholder="Enter amount" /></TableCell>)}
                      <TableCell>—</TableCell>
                    </TableRow>
                    {installments.map((r, i) => {
                      const isFinal = i === installments.length - 1;
                      return <TableRow key={i}>
                        <TableCell>
                          <span className="font-medium">Installment {i + 1}{isFinal && calcType === "FIXED_AMOUNT" ? " — Balance" : ""}</span>
                        </TableCell>
                        {calcType === "PERCENTAGE" && <TableCell>{isFinal ? <span className="font-medium text-muted-foreground">Balance</span> : <div className="flex items-center gap-1"><FormattedNumberInput aria-label={`Installment ${i + 1} percentage`} className="w-24" value={r.value === 0 ? "" : String(r.value)} onValueChange={value => updateRow(i, { value: Number(value) || 0 })} placeholder="Enter %" /><span>%</span></div>}</TableCell>}
                        {paymentColumns.map((c, col) => <TableCell key={col} className="text-right tabular-nums">
                          {!isFinal && calcType === "FIXED_AMOUNT"
                            ? <FormattedNumberInput aria-label={`Installment ${i + 1} amount`} className="text-right" value={r.value === 0 ? "" : String(r.value)} onValueChange={value => updateRow(i, { value: Number(value) || 0 })} placeholder="Enter amount" />
                            : formatCurrency(columnAmounts[col][i].plannedAmount)}
                        </TableCell>)}
                        <TableCell><FormattedNumberInput aria-label={`Installment ${i + 1} days after billing`} value={r.daysAfterBillingDate === 0 ? "" : String(r.daysAfterBillingDate)} onValueChange={value => updateRow(i, { daysAfterBillingDate: Number(value) || 0 })} placeholder="Enter days" /></TableCell>
                      </TableRow>;
                    })}
                    <TableRow className="bg-muted/30 font-semibold hover:bg-muted/30">
                      <TableCell>Total</TableCell>
                      {calcType === "PERCENTAGE" && <TableCell>100%</TableCell>}
                      {paymentColumns.map((column, index) => <TableCell key={index} className="text-right tabular-nums">{formatCurrency(column.valueWithGST)}</TableCell>)}
                      <TableCell>—</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              {finalNegative && <p className="text-xs text-destructive">The earlier installments exceed the {calcType === "PERCENTAGE" ? "100% total" : "scheme value"} — the final installment would be negative.</p>}
              {bookingTooBig && <p className="text-xs text-destructive">Booking Amount and earlier installments exceed the scheme value. Reduce the booking or earlier installments.</p>}
              <p className="text-xs text-muted-foreground">{FL.bookingNote}</p>
            </div>
          </FormSection>

          {/* 4. TIMELINE — dates, pre-placement ceiling, and conversion-date extension config. */}
          <FormSection title={FL.sectionTimeline}>
            {/* "Perpetual Scheme" is intentionally HIDDEN from the UI (its DB field + isPerpetual state are
                retained for existing data/backend behaviour; there is simply no toggle in Create/Edit). */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>{FL.schemeStart} *</Label><SchemeDateInput value={startDate} onValueChange={setStartDate} /></div>
              <div className="space-y-1.5"><Label>{FL.schemeEnd} *</Label><SchemeDateInput value={endDate} onValueChange={setEndDate} /></div>
              <div className="space-y-1.5"><Label>{FL.lastBookingDate} *</Label><SchemeDateInput value={bookingLastDate} onValueChange={setBookingLastDate} /></div>
              {/* Pre-placement MASTER ceiling — the max days a dealer may be allowed; actual value chosen in planning. */}
              <div className="space-y-1.5"><Label>{FL.prePlacement} *</Label><NativeSelect value={prePlacementMaxDays} onChange={(e) => setPrePlacementMaxDays(e.target.value)} options={[{ value: "", label: "Select..." }, ...[0, 15, 30, 45].map((value) => ({ value: String(value), label: String(value) }))]} /></div>
              <div className="space-y-1.5"><Label>{FL.maxExtDays} *</Label><NativeSelect value={maxExtDays} onChange={(e) => setMaxExtDays(e.target.value)} options={[{ value: "", label: "Select..." }, ...[5, 10, 15, 20, 25, 30].map((value) => ({ value: String(value), label: String(value) }))]} /></div>
              <div className="space-y-1.5"><Label>{FL.maxExtAttempts} *</Label><NativeSelect value={maxExtAttempts} onChange={(e) => setMaxExtAttempts(e.target.value)} options={[{ value: "", label: "Select..." }, { value: "-1", label: "No Limit" }, ...[1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) })), ...preservedExtensionAttemptOption]} /></div>
            </div>
          </FormSection>

          {/* SCHEME DOCUMENT */}
          <FormSection title={FL.sectionDocument}>
            <div className="space-y-1.5"><Label>{FL.schemeDocument}</Label><Input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,image/*" onChange={(e) => upload(e.target.files?.[0])} />{documentUrl && <div className="flex items-center gap-2 text-xs text-muted-foreground"><FileText className="h-4 w-4" />Document attached <Button variant="ghost" size="sm" onClick={() => setDocumentUrl("")}><X className="h-3 w-3" /></Button></div>}</div>
          </FormSection>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="shrink-0 border-t pt-4">
          <Button variant="outline" onClick={onClose}>{FL.cancel}</Button>
          <Button disabled={!name.trim() || !stateIds.length || !structure || !multiple || !benefit || !otherBenefitDetails.trim() || !prePlacementMaxDays || !maxExtDays || maxExtAttempts === "" || (!isPerpetual && (!startDate || !endDate || !bookingLastDate)) || installments.length === 0 || !installmentMode || (!isOptions && (bookingAmount === "" || valueWithoutGST === "" || valueWithGST === "" || !fixedGstValid)) || (benefit === "OTHER" && !benefitDetails.trim()) || !installValid || (isOptions ? !optionsValid : !requirementValid) || save.isPending} onClick={() => { setError(null); save.mutate(); }}>{scheme ? FL.saveChanges : FL.saveScheme}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
