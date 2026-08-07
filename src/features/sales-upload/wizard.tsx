"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Check, ArrowLeft, ArrowRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportPreviewReport, type ImportPreviewReportData } from "./import-preview-report";

interface Analysis {
  workbookName: string;
  targetMonth: { id: string; name: string; seasonName: string };
  dealersFound: number;
  productsFound: number;
  duplicatesMerged: number;
  unknownDealers: string[];
  unknownProducts: string[];
  dealersWithoutPlan: string[];
  rowsToImport: number;
  warnings: string[];
  report: ImportPreviewReportData | null;
}
interface CommitResult {
  runId: string;
  rowsImported: number;
  dealersUpdated: number;
  productsUpdated: number;
  unknownDealers: number;
  unknownProducts: number;
  autoAddedLines: number;
}

type Step = "upload" | "review" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "Upload & Analyze" },
  { key: "review", label: "Review" },
  { key: "done", label: "Imported" },
];

/**
 * Sales Upload — Tally Product.xlsx actual-sales import. Same wizard shape as Company
 * Onboarding: Upload → Analyze → Review → Commit. Only Commit writes; it fills MonthlyEntry
 * actual fields (saleQty / saleValue) for the chosen Target Month.
 */
export function SalesUploadWizard() {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sales Period + Target Month.
  const [seasonMonthId, setSeasonMonthId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // Auto-add unplanned products to the Seasonal Plan (default off). Keys are "officerId|productId".
  const [autoAdd, setAutoAdd] = useState(false);
  const [selectedUnplanned, setSelectedUnplanned] = useState<Set<string>>(new Set());

  const { data: months } = useQuery<{ id: string; label: string }[]>({
    queryKey: ["sales-upload-months"],
    queryFn: () => api.get("/api/sales-upload/months"),
  });

  const dataPayload = () => JSON.stringify({ seasonMonthId, fromDate: fromDate || undefined, toDate: toDate || undefined });
  // Only auto-addable entries (dealer has an approved seasonal plan → officerId present).
  const autoAddableKeys = () =>
    [...new Set((analysis?.report?.matchedNotPlanned ?? []).filter((r) => r.officerId).map((r) => `${r.officerId}|${r.productId}`))];
  const commitDataPayload = () => {
    const selections = autoAdd
      ? [...selectedUnplanned].map((k) => { const [officerId, productId] = k.split("|"); return { officerId, productId }; })
      : [];
    return JSON.stringify({ seasonMonthId, fromDate: fromDate || undefined, toDate: toDate || undefined, autoAddUnplanned: selections });
  };

  const analyzeMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append("data", dataPayload());
      const res = await fetch("/api/sales-upload/analyze", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Analysis failed");
      return body as Analysis;
    },
    onSuccess: (a) => {
      setAnalysis(a);
      setAutoAdd(false);
      setSelectedUnplanned(new Set());
      setStep("review");
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  const onAutoAddChange = (on: boolean) => {
    setAutoAdd(on);
    setSelectedUnplanned(on ? new Set(autoAddableKeys()) : new Set());
  };
  const onToggleUnplanned = (key: string) =>
    setSelectedUnplanned((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const commitMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append("data", commitDataPayload());
      const res = await fetch("/api/sales-upload/commit", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Import failed");
      return body as CommitResult;
    },
    onSuccess: (r) => {
      setResult(r);
      setStep("done");
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  const canAnalyze = !!file && !!seasonMonthId;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sales Upload"
        subtitle="Upload a Tally-exported Product.xlsx (Sales Register). The system fills Actual Sales (quantity and amount) for every matched dealer and product in the chosen month — Sales Officers no longer enter actuals manually. Excel is parsed in memory and never stored."
      />

      <div className="flex items-center gap-2 text-sm">
        {STEPS.map((s, i) => {
          const active = STEPS.findIndex((x) => x.key === step) >= i;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className={cn("flex h-6 w-6 items-center justify-center rounded-full border text-xs", active ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}>{i + 1}</span>
              <span className={cn(active ? "font-medium" : "text-muted-foreground")}>{s.label}</span>
              {i < STEPS.length - 1 && <span className="mx-1 text-muted-foreground">→</span>}
            </div>
          );
        })}
      </div>

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

      {step === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sales Period & Workbook</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-3">
                <Label>Target Month</Label>
                <NativeSelect
                  placeholder="Choose the month to fill…"
                  options={(months ?? []).map((m) => ({ value: m.id, label: m.label }))}
                  value={seasonMonthId}
                  onChange={(e) => setSeasonMonthId(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>From Date</Label>
                <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>To Date</Label>
                <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Upload Product.xlsx</Label>
              <input
                type="file"
                accept=".xlsx,.xls"
                className="block text-sm"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setError(null);
                }}
              />
              <p className="text-xs text-muted-foreground">Accepts .xlsx / .xls. Parsed in memory; the workbook is never stored.</p>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => analyzeMut.mutate()} disabled={!canAnalyze || analyzeMut.isPending}>
                {analyzeMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing…</> : <><ArrowRight className="h-4 w-4" /> Analyze</>}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "review" && analysis && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Target month: <span className="font-medium text-foreground">{analysis.targetMonth.seasonName} · {analysis.targetMonth.name}</span>
          </p>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Dealers Found" value={analysis.dealersFound} />
            <Stat label="Products Found" value={analysis.productsFound} />
            <Stat label="Duplicates Merged" value={analysis.duplicatesMerged} />
            <Stat label="Unknown Dealers" value={analysis.unknownDealers.length} warn={analysis.unknownDealers.length > 0} />
            <Stat label="Unknown Products" value={analysis.unknownProducts.length} warn={analysis.unknownProducts.length > 0} />
            <Stat label="Rows To Import" value={analysis.rowsToImport} good />
          </div>

          {analysis.warnings.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              <p className="flex items-center gap-1 font-medium"><AlertTriangle className="h-4 w-4" /> Warnings</p>
              <ul className="list-disc pl-5">{analysis.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}

          {(analysis.unknownDealers.length > 0 || analysis.unknownProducts.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {analysis.unknownDealers.length > 0 && <UnknownList title="Unknown Dealers" items={analysis.unknownDealers} hint="Add a Dealer Alias or create the dealer." />}
              {analysis.unknownProducts.length > 0 && <UnknownList title="Unknown Products" items={analysis.unknownProducts} hint="These product names did not match the Product Master." />}
            </div>
          )}

          {/* Verification-only detailed preview + optional auto-add of unplanned products. */}
          {analysis.report && (
            <ImportPreviewReport
              report={analysis.report}
              workbookName={analysis.workbookName}
              autoAddControls={{ autoAdd, onAutoAddChange, selected: selectedUnplanned, onToggle: onToggleUnplanned }}
            />
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep("upload")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button onClick={() => commitMut.mutate()} disabled={commitMut.isPending || (analysis.rowsToImport === 0 && !(autoAdd && selectedUnplanned.size > 0))}>
              {commitMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</> : <><ArrowRight className="h-4 w-4" /> Import Sales</>}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-lg font-medium text-success">
            <Check className="h-6 w-6" /> Sales imported
          </p>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Rows Imported" value={result.rowsImported} good />
            <Stat label="Dealers Updated" value={result.dealersUpdated} />
            <Stat label="Products Updated" value={result.productsUpdated} />
            <Stat label="Unknown Dealers" value={result.unknownDealers} warn={result.unknownDealers > 0} />
            <Stat label="Unknown Products" value={result.unknownProducts} warn={result.unknownProducts > 0} />
            <Stat label="Auto-Added Plan Lines" value={result.autoAddedLines} good={result.autoAddedLines > 0} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline"><Link href="/planning/sales-upload/history">Sales Upload history</Link></Button>
            <Button variant="outline" onClick={() => window.location.reload()}>Upload another workbook</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, warn, good }: { label: string; value: number; warn?: boolean; good?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-semibold", warn && value > 0 && "text-warning", good && "text-success")}>{value}</p>
    </div>
  );
}

function UnknownList({ title, items, hint }: { title: string; items: string[]; hint: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">{title} ({items.length})</p>
      <p className="mb-1 text-xs text-muted-foreground">{hint}</p>
      <ul className="max-h-40 space-y-0.5 overflow-auto text-sm">
        {items.slice(0, 100).map((it, i) => <li key={i} className="text-muted-foreground">{it}</li>)}
      </ul>
    </div>
  );
}
