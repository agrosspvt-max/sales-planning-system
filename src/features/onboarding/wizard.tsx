"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { Upload, Loader2, Check, ArrowLeft, ArrowRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { MONTH_OPTIONS } from "@/lib/season-months";
import { MigrationReportView } from "./report-view";
import { loadReport, type LoadedReport } from "./report";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Analysis {
  sourceName: string;
  officer: { name: string | null; matched: boolean };
  seasonHint: { name: string; startMonth: number; startYear: number; endMonth: number; endYear: number };
  packSizes: { total: number; existing: number; missing: string[] };
  products: { total: number; existing: number; missing: number };
  dealers: { total: number; existing: number; missing: number };
  planningRows: number;
  warnings: string[];
}

type Step = "upload" | "review" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "review", label: "Review & Confirm" },
  { key: "done", label: "Migration Report" },
];

export function OnboardingWizard() {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [report, setReport] = useState<LoadedReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Confirmed season fields (prefilled from the hint).
  const [seasonName, setSeasonName] = useState("");
  const [startMonth, setStartMonth] = useState(6);
  const [startYear, setStartYear] = useState(new Date().getFullYear());
  const [endMonth, setEndMonth] = useState(11);
  const [endYear, setEndYear] = useState(new Date().getFullYear());
  const [importAsApproved, setImportAsApproved] = useState(false);

  const analyzeMut = useMutation({
    mutationFn: async (f: File) => {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch("/api/onboarding/analyze", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Analysis failed");
      return body as Analysis;
    },
    onSuccess: (a) => {
      setAnalysis(a);
      setSeasonName(a.seasonHint.name);
      setStartMonth(a.seasonHint.startMonth);
      setStartYear(a.seasonHint.startYear);
      setEndMonth(a.seasonHint.endMonth);
      setEndYear(a.seasonHint.endYear);
      setStep("review");
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  const commitMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append(
        "data",
        JSON.stringify({ seasonName, startMonth, startYear, endMonth, endYear, importAsApproved }),
      );
      const res = await fetch("/api/onboarding/commit", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Onboarding failed");
      return body as unknown;
    },
    // Run the API response through the same load pipeline the History page uses, so the
    // wizard renders exactly one validated, current-schema report shape.
    onSuccess: (r) => {
      setReport(loadReport(r));
      setStep("done");
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Company Onboarding"
        subtitle="Bring your existing data into the application. Upload a completed planning workbook; the system creates the missing masters (pack sizes, products, dealers, officer), the season, and the seasonal plan — reusing the existing services. Excel is the first supported source."
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
            <CardTitle className="text-base">Choose source — Excel Workbook</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Accepts .xlsx / .xls. Parsed in memory; the workbook is never stored.</p>
            <input
              type="file"
              accept=".xlsx,.xls"
              className="block text-sm"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                setError(null);
                if (f) analyzeMut.mutate(f);
              }}
            />
            {analyzeMut.isPending && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Analyzing workbook…
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {step === "review" && analysis && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Detect label="Pack Sizes" total={analysis.packSizes.total} existing={analysis.packSizes.existing} />
            <Detect label="Products" total={analysis.products.total} existing={analysis.products.existing} />
            <Detect label="Dealers" total={analysis.dealers.total} existing={analysis.dealers.existing} />
            <div className="rounded-md border p-3">
              <p className="text-xs uppercase text-muted-foreground">Sales Officer</p>
              <p className="text-sm font-medium">{analysis.officer.name ?? "—"}</p>
              <p className="text-xs text-muted-foreground">{analysis.officer.matched ? "matched existing" : "will be created"}</p>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Confirm the Season</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Season name</Label>
                  <Input value={seasonName} onChange={(e) => setSeasonName(e.target.value)} />
                </div>
                <div />
                <div className="space-y-1.5">
                  <Label>Start month</Label>
                  <NativeSelect options={MONTH_OPTIONS} value={String(startMonth)} onChange={(e) => setStartMonth(Number(e.target.value))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Start year</Label>
                  <Input type="number" value={startYear} onChange={(e) => setStartYear(Number(e.target.value))} />
                </div>
                <div className="space-y-1.5">
                  <Label>End month</Label>
                  <NativeSelect options={MONTH_OPTIONS} value={String(endMonth)} onChange={(e) => setEndMonth(Number(e.target.value))} />
                </div>
                <div className="space-y-1.5">
                  <Label>End year</Label>
                  <Input type="number" value={endYear} onChange={(e) => setEndYear(Number(e.target.value))} />
                </div>
              </div>
              <label className="flex items-start gap-2 border-t pt-3 text-sm">
                <input type="checkbox" className="mt-1" checked={importAsApproved} onChange={(e) => setImportAsApproved(e.target.checked)} />
                <span>
                  <span className="font-medium">Import as Approved</span>
                  <span className="block text-xs text-muted-foreground">This season was already approved in operations. Otherwise it starts as Draft.</span>
                </span>
              </label>
              <p className="text-sm text-muted-foreground">
                Will import <span className="font-medium">{analysis.planningRows}</span> planning rows across{" "}
                <span className="font-medium">{analysis.dealers.total}</span> dealers after masters are created.
              </p>
            </CardContent>
          </Card>

          {analysis.warnings.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              <p className="flex items-center gap-1 font-medium"><AlertTriangle className="h-4 w-4" /> Warnings</p>
              <ul className="list-disc pl-5">{analysis.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep("upload")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button onClick={() => commitMut.mutate()} disabled={commitMut.isPending || !seasonName}>
              {commitMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Migrating…</> : <><ArrowRight className="h-4 w-4" /> Run onboarding</>}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && report && (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-lg font-medium text-success">
            <Check className="h-6 w-6" /> Onboarding complete
          </p>
          <MigrationReportView loaded={report} />
          <div className="flex flex-wrap gap-2">
            {report.report.planId && (
              <Button asChild>
                <Link href={`/planning/${report.report.planId}`}>Open the Sales Plan</Link>
              </Button>
            )}
            <Button asChild variant="outline">
              <Link href="/planning/sales/plans">View all plans</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/onboarding/history">Onboarding history</Link>
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>Onboard another workbook</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Detect({ label, total, existing }: { label: string; total: number; existing: number }) {
  const missing = total - existing;
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold">{total}</p>
      <p className="text-xs text-muted-foreground">
        {existing} existing · <span className={cn(missing > 0 && "text-warning")}>{missing} to create</span>
      </p>
    </div>
  );
}
