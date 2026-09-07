"use client";

import { Fragment, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Check, ArrowLeft, ArrowRight, ChevronRight, ChevronDown, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLabel } from "@/features/labels/label-ui";

/* --------------------------------- API shapes (mirror scheme-upload.server) --------------------------------- */

interface SchemeOption { id: string; schemeName: string; requirementType: "PRODUCT_BASED" | "VALUE_BASED"; valueMode: "INDIVIDUAL" | "COMBINED" | null; isPerpetual: boolean; startDate: string | null; endDate: string | null; status: string }
interface ImpactLine {
  dealerId: string; dealerName: string; productId: string; productName: string;
  requiredQty: number; requiredValue: number; previouslyAchievedQty: number; previouslyAchievedValue: number;
  incomingQty: number; incomingValue: number; newTotalQty: number; newTotalValue: number;
  remainingQty: number; remainingValue: number; completedBefore: boolean; completedAfter: boolean;
}
interface CombinedDealerLine { dealerId: string; dealerName: string; requiredValue: number; previouslyAchievedValue: number; incomingValue: number; newTotalValue: number; remainingValue: number; completedBefore: boolean; completedAfter: boolean }
interface SchemeAnalysis {
  schemeId: string; schemeName: string; requirementType: "NONE" | "PRODUCT_BASED" | "VALUE_BASED"; valueMode: "INDIVIDUAL" | "COMBINED" | null;
  valid: boolean; invalidReason: string | null; hasExistingScope: boolean;
  enrolledChecked: number; matchedDealers: number; notEnrolledDealers: number;
  requiredProducts: number; matchedRequiredProducts: number; notRequiredProducts: number;
  incomingQty: number; incomingValue: number; dealersAffected: number; newlyCompleted: number; contributions: number;
  lines: ImpactLine[]; combinedByDealer: CombinedDealerLine[];
}
interface Analysis {
  fileName: string; startDate: string; endDate: string; parsedDealers: number;
  unmatchedDealers: string[]; unmatchedProducts: string[]; schemes: SchemeAnalysis[]; totalContributions: number; anyExistingScope: boolean;
}
interface CommitResult { batchId: string; totalContributions: number; schemes: { schemeId: string; schemeName: string; contributions: number; dealersAffected: number; superseded: boolean }[] }

const fmtQty = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
const q = (n: number) => fmtQty.format(n);
const isValueScheme = (s: SchemeAnalysis) => s.requirementType === "VALUE_BASED";
const isCombined = (s: SchemeAnalysis) => s.requirementType === "VALUE_BASED" && s.valueMode === "COMBINED";

/**
 * SCHEME UPLOAD wizard (Phase 7) — Select Schemes + Date Range → Upload → Analyze → Review → Confirm Import.
 * A dedicated achievement upload, fully isolated from normal Sales Planning (the server writes only the
 * scheme tracking tables). Reuses the shared Tally parser, dealer resolver, product resolver and the
 * Phase 4 achievement engine. Read-only until the user confirms the import.
 */
export function SchemeUploadWizard() {
  const [step, setStep] = useState<"setup" | "review" | "done">("setup");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tSelect = useLabel("scheme_upload.select_schemes");
  const tStart = useLabel("scheme_upload.start_date");
  const tEnd = useLabel("scheme_upload.end_date");
  const tFile = useLabel("scheme_upload.file");
  const tAnalyze = useLabel("scheme_upload.analyze");
  const tConfirm = useLabel("scheme_upload.confirm_import");

  const { data: schemes = [] } = useQuery<SchemeOption[]>({ queryKey: ["scheme-upload-options"], queryFn: () => api.get("/api/scheme-upload/schemes") });

  const payload = (withReplace = false) => JSON.stringify({ startDate, endDate, schemeIds: [...selected], ...(withReplace ? { replace: true } : {}) });
  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const analyzeMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append("data", payload());
      const res = await fetch("/api/scheme-upload/analyze", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Analysis failed");
      return body as Analysis;
    },
    onSuccess: (a) => { setAnalysis(a); setReplace(false); setStep("review"); setError(null); },
    onError: (e) => setError((e as Error).message),
  });
  const commitMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append("data", payload(replace));
      const res = await fetch("/api/scheme-upload/commit", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Import failed");
      return body as CommitResult;
    },
    onSuccess: (r) => { setResult(r); setStep("done"); setError(null); },
    onError: (e) => setError((e as Error).message),
  });

  const reset = () => { setStep("setup"); setFile(null); setAnalysis(null); setResult(null); setReplace(false); setError(null); };
  const canAnalyze = !!file && selected.size > 0 && !!startDate && !!endDate && !analyzeMut.isPending;
  const importableContribs = analysis?.totalContributions ?? 0;
  const needsReplaceConfirm = !!analysis?.anyExistingScope;
  const canImport = importableContribs > 0 && !commitMut.isPending && (!needsReplaceConfirm || replace);

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{useLabel("scheme_upload.title")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{error}</div>}

        {step === "setup" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upload a Tally Sales Register for a date range to track scheme achievement. It updates only scheme
              achievement data — <span className="font-medium">no normal Sales / Monthly / Recovery actuals are touched</span>.
              Only enrolled dealers and each scheme&apos;s required products contribute.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>{tStart} *</Label><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{tEnd} *</Label><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
            </div>
            <div className="space-y-1.5">
              <Label>{tSelect} *</Label>
              <div className="max-h-56 space-y-1 overflow-auto rounded-md border p-2">
                {schemes.length === 0 ? (
                  <p className="p-2 text-sm text-muted-foreground">No Product/Value schemes available. Only schemes with a Product or Value requirement can receive a Scheme Upload.</p>
                ) : schemes.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted/50">
                    <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                    <span className="font-medium">{s.schemeName}</span>
                    <Badge variant="secondary">{s.requirementType === "VALUE_BASED" ? `Value · ${s.valueMode === "COMBINED" ? "Combined" : "Individual"}` : "Product"}</Badge>
                    {s.status === "CLOSED" && <Badge variant="muted">Closed</Badge>}
                    <span className="ml-auto text-xs text-muted-foreground">{s.isPerpetual ? "Perpetual" : `${s.startDate ? new Date(s.startDate).toLocaleDateString("en-IN") : "—"} – ${s.endDate ? new Date(s.endDate).toLocaleDateString("en-IN") : "—"}`}</span>
                  </label>
                ))}
              </div>
              {selected.size > 0 && <p className="text-xs text-muted-foreground">{selected.size} scheme(s) selected.</p>}
            </div>
            <div className="space-y-1.5">
              <Label>{tFile}</Label>
              <input type="file" accept=".xlsx,.xls" className="block text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
            </div>
            <div className="flex justify-end">
              <Button onClick={() => analyzeMut.mutate()} disabled={!canAnalyze}>
                {analyzeMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing…</> : <><ArrowRight className="h-4 w-4" /> {tAnalyze}</>}
              </Button>
            </div>
          </div>
        )}

        {step === "review" && analysis && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p className="text-muted-foreground">{analysis.fileName} · {new Date(analysis.startDate).toLocaleDateString("en-IN")} – {new Date(analysis.endDate).toLocaleDateString("en-IN")} · {analysis.parsedDealers} dealer(s) in file</p>
              <p className="font-medium">{analysis.totalContributions} contribution(s) to import</p>
            </div>

            {(analysis.unmatchedDealers.length > 0 || analysis.unmatchedProducts.length > 0) && (
              <div className="grid gap-2 sm:grid-cols-2">
                {analysis.unmatchedDealers.length > 0 && <ExcludedBox title={`Unmatched dealers (${analysis.unmatchedDealers.length})`} items={analysis.unmatchedDealers} />}
                {analysis.unmatchedProducts.length > 0 && <ExcludedBox title={`Unmatched products (${analysis.unmatchedProducts.length})`} items={analysis.unmatchedProducts} />}
              </div>
            )}

            {analysis.schemes.map((s) => <SchemeReview key={s.schemeId} s={s} />)}

            {needsReplaceConfirm && (
              <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span className="space-y-1">
                  <span className="block font-medium">Existing Scheme Upload data exists for this date range.</span>
                  <span className="flex items-center gap-2"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace it — the old scope becomes SUPERSEDED (kept for history); achievement uses only the new data.</span>
                </span>
              </label>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep("setup")}><ArrowLeft className="h-4 w-4" /> Back</Button>
              <Button onClick={() => commitMut.mutate()} disabled={!canImport} title={importableContribs === 0 ? "No valid contributions to import" : undefined}>
                {commitMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</> : <><Check className="h-4 w-4" /> {tConfirm} ({importableContribs})</>}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 font-medium text-success"><Check className="h-5 w-5" /> Scheme Upload imported — {result.totalContributions} contribution(s) across {result.schemes.length} scheme(s).</p>
            <div className="space-y-1 text-sm">
              {result.schemes.map((c) => (
                <div key={c.schemeId} className="flex flex-wrap justify-between gap-2 rounded-md border px-2 py-1">
                  <span className="font-medium">{c.schemeName} {c.superseded && <Badge variant="muted">Replaced</Badge>}</span>
                  <span className="text-muted-foreground">{c.contributions} fact(s) · {c.dealersAffected} dealer(s)</span>
                </div>
              ))}
            </div>
            <Button variant="outline" onClick={reset}>Upload another</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ExcludedBox({ title, items }: { title: string; items: string[] }) {
  return (
    <details className="group rounded-md border">
      <summary className="flex cursor-pointer list-none items-center gap-1 p-2 text-xs font-medium">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" /> {title}
      </summary>
      <div className="max-h-40 space-y-0.5 overflow-auto border-t px-3 py-2 text-xs text-muted-foreground">
        {items.map((x, i) => <div key={i}>{x}</div>)}
      </div>
    </details>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[11px] uppercase text-muted-foreground">{label}</p>
      <p className={cn("font-semibold tabular-nums", warn && "text-warning")}>{value}</p>
    </div>
  );
}

function SchemeReview({ s }: { s: SchemeAnalysis }) {
  const [open, setOpen] = useState(false);
  const value = isValueScheme(s);
  const combined = isCombined(s);
  return (
    <div className="rounded-md border">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 p-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-semibold">{s.schemeName}</span>
        <Badge variant="secondary">{value ? `Value · ${s.valueMode === "COMBINED" ? "Combined" : "Individual"}` : "Product"}</Badge>
        {s.hasExistingScope && <Badge variant="warning">Replaces existing</Badge>}
        {!s.valid && <Badge variant="destructive">Skipped</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">
          {s.valid ? <>{s.contributions} contribution(s) · {s.dealersAffected} dealer(s){s.newlyCompleted > 0 && ` · ${s.newlyCompleted} newly complete`}</> : s.invalidReason}
        </span>
      </button>
      {open && s.valid && (
        <div className="space-y-3 border-t p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Enrolled checked" value={String(s.enrolledChecked)} />
            <Stat label="Matched dealers" value={String(s.matchedDealers)} />
            <Stat label="Not enrolled" value={String(s.notEnrolledDealers)} warn={s.notEnrolledDealers > 0} />
            <Stat label="Not required" value={String(s.notRequiredProducts)} warn={s.notRequiredProducts > 0} />
            <Stat label="Required products" value={String(s.requiredProducts)} />
            <Stat label="Matched required" value={String(s.matchedRequiredProducts)} />
            <Stat label={value ? "Incoming value" : "Incoming qty"} value={value ? formatCurrency(s.incomingValue) : q(s.incomingQty)} />
            <Stat label="Newly completed" value={String(s.newlyCompleted)} />
          </div>

          {s.contributions === 0 ? (
            <p className="text-sm text-muted-foreground">No enrolled dealer + required product contributions from this file.</p>
          ) : combined ? (
            <CombinedTable rows={s.combinedByDealer} />
          ) : value ? (
            <ValueTable lines={s.lines.filter((l) => l.incomingValue !== 0 || l.previouslyAchievedValue !== 0)} />
          ) : (
            <ProductTable lines={s.lines.filter((l) => l.incomingQty !== 0 || l.previouslyAchievedQty !== 0)} />
          )}
        </div>
      )}
    </div>
  );
}

function ProductTable({ lines }: { lines: ImpactLine[] }) {
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-left"><tr>
          <th className="p-1.5">Dealer</th><th className="p-1.5">Product</th>
          <th className="p-1.5 text-right">Required</th><th className="p-1.5 text-right">Previously</th><th className="p-1.5 text-right">Incoming</th>
          <th className="p-1.5 text-right">New Total</th><th className="p-1.5 text-right">Remaining</th><th className="p-1.5 text-right">Completion</th>
        </tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.dealerId}|${l.productId}`} className="border-t">
              <td className="p-1.5">{l.dealerName}</td><td className="p-1.5">{l.productName}</td>
              <td className="p-1.5 text-right tabular-nums">{q(l.requiredQty)}</td>
              <td className="p-1.5 text-right tabular-nums">{q(l.previouslyAchievedQty)}</td>
              <td className="p-1.5 text-right tabular-nums font-medium">{q(l.incomingQty)}</td>
              <td className="p-1.5 text-right tabular-nums">{q(l.newTotalQty)}</td>
              <td className={cn("p-1.5 text-right tabular-nums", l.remainingQty > 0 && "text-destructive")}>{q(l.remainingQty)}</td>
              <td className="p-1.5 text-right">{l.completedAfter ? <Badge variant="success">Complete</Badge> : `${q(l.newTotalQty)} / ${q(l.requiredQty)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValueTable({ lines }: { lines: ImpactLine[] }) {
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-left"><tr>
          <th className="p-1.5">Dealer</th><th className="p-1.5">Product</th>
          <th className="p-1.5 text-right">Required</th><th className="p-1.5 text-right">Previously</th><th className="p-1.5 text-right">Incoming</th>
          <th className="p-1.5 text-right">New Total</th><th className="p-1.5 text-right">Remaining</th><th className="p-1.5 text-right">Completion</th>
        </tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.dealerId}|${l.productId}`} className="border-t">
              <td className="p-1.5">{l.dealerName}</td><td className="p-1.5">{l.productName}</td>
              <td className="p-1.5 text-right tabular-nums">{formatCurrency(l.requiredValue)}</td>
              <td className="p-1.5 text-right tabular-nums">{formatCurrency(l.previouslyAchievedValue)}</td>
              <td className="p-1.5 text-right tabular-nums font-medium">{formatCurrency(l.incomingValue)}</td>
              <td className="p-1.5 text-right tabular-nums">{formatCurrency(l.newTotalValue)}</td>
              <td className={cn("p-1.5 text-right tabular-nums", l.remainingValue > 0 && "text-destructive")}>{formatCurrency(l.remainingValue)}</td>
              <td className="p-1.5 text-right">{l.completedAfter ? <Badge variant="success">Complete</Badge> : "Pending"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CombinedTable({ rows }: { rows: CombinedDealerLine[] }) {
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-left"><tr>
          <th className="p-1.5">Dealer</th>
          <th className="p-1.5 text-right">Combined Required</th><th className="p-1.5 text-right">Previously</th><th className="p-1.5 text-right">Incoming</th>
          <th className="p-1.5 text-right">New Total</th><th className="p-1.5 text-right">Remaining</th><th className="p-1.5 text-right">Completion</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.dealerId}>
              <tr className="border-t">
                <td className="p-1.5">{r.dealerName}</td>
                <td className="p-1.5 text-right tabular-nums">{formatCurrency(r.requiredValue)}</td>
                <td className="p-1.5 text-right tabular-nums">{formatCurrency(r.previouslyAchievedValue)}</td>
                <td className="p-1.5 text-right tabular-nums font-medium">{formatCurrency(r.incomingValue)}</td>
                <td className="p-1.5 text-right tabular-nums">{formatCurrency(r.newTotalValue)}</td>
                <td className={cn("p-1.5 text-right tabular-nums", r.remainingValue > 0 && "text-destructive")}>{formatCurrency(r.remainingValue)}</td>
                <td className="p-1.5 text-right">{r.completedAfter ? <Badge variant="success">Complete</Badge> : "Pending"}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
