"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Check, ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface MatchedLine { dealerName: string; officerName: string; receipt: number; srCr: number }
interface SkippedLine { dealerName: string; reason: string }
interface Analysis {
  workbookName: string;
  monthName: string;
  seasonName: string;
  summary: { totalRows: number; dealersMatched: number; dealersSkipped: number; receiptTotal: number; srCrTotal: number };
  matched: MatchedLine[];
  skipped: SkippedLine[];
}
interface CommitResult { monthName: string; dealersUpdated: number; receiptTotal: number; srCrTotal: number; dealersCleared: number }

const fmt = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);

/**
 * Daybook Upload — a SEPARATE business document from Sales Upload. Scoped to one Recovery month, it
 * populates SR/CR + Live Recovery via the shared Recovery preview shape (Upload → Analyze → Review →
 * Commit). Dealer matching is the shared Dealer Alias resolver; it writes no aging/planning fields.
 */
export function DaybookUploadWizard() {
  const [step, setStep] = useState<"upload" | "review" | "done">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [seasonMonthId, setSeasonMonthId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: months } = useQuery<{ id: string; label: string }[]>({
    queryKey: ["sales-upload-months"],
    queryFn: () => api.get("/api/sales-upload/months"),
  });
  const payload = () => JSON.stringify({ seasonMonthId, fromDate, toDate });

  const analyzeMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append("data", payload());
      const res = await fetch("/api/recovery/daybook/analyze", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Analysis failed");
      return body as Analysis;
    },
    onSuccess: (a) => { setAnalysis(a); setStep("review"); setError(null); },
    onError: (e) => setError((e as Error).message),
  });
  const commitMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append("data", payload());
      const res = await fetch("/api/recovery/daybook/commit", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Commit failed");
      return body as CommitResult;
    },
    onSuccess: (r) => { setResult(r); setStep("done"); setError(null); },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Daybook Upload</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{error}</div>}

        {step === "upload" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Upload the Tally Day Book for one calendar month. It updates only <span className="font-medium">SR / CR</span> and <span className="font-medium">Live Recovery</span> for the selected month&apos;s Recovery Plans — no aging or planning value is changed. Dealer names are matched through the shared Dealer Alias system.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Recovery Month</Label>
                <NativeSelect placeholder="Choose the month…" options={(months ?? []).map((m) => ({ value: m.id, label: m.label }))} value={seasonMonthId} onChange={(e) => setSeasonMonthId(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Start Date</Label>
                <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>End Date</Label>
                <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Day Book (.xlsx)</Label>
              <input type="file" accept=".xlsx,.xls" className="block text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
            </div>
            <div className="flex justify-end">
              <Button onClick={() => analyzeMut.mutate()} disabled={!file || !seasonMonthId || analyzeMut.isPending}>
                {analyzeMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing…</> : <><ArrowRight className="h-4 w-4" /> Analyze</>}
              </Button>
            </div>
          </div>
        )}

        {step === "review" && analysis && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{analysis.seasonName} · {analysis.monthName}</p>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              <Stat label="Total rows" value={String(analysis.summary.totalRows)} />
              <Stat label="Dealers matched" value={String(analysis.summary.dealersMatched)} />
              <Stat label="Dealers skipped" value={String(analysis.summary.dealersSkipped)} warn={analysis.summary.dealersSkipped > 0} />
              <Stat label="Receipt total" value={fmt(analysis.summary.receiptTotal)} />
              <Stat label="SR/CR total" value={fmt(analysis.summary.srCrTotal)} />
            </div>

            <Section title={`Matched Dealers (${analysis.matched.length})`}>
              <div className="grid grid-cols-4 gap-2 border-b pb-1 text-[11px] font-medium uppercase text-muted-foreground">
                <span>Dealer</span><span>Officer</span><span className="text-right">Receipt</span><span className="text-right">SR/CR</span>
              </div>
              {analysis.matched.length === 0 ? <p className="py-1 text-xs text-muted-foreground">None.</p> : analysis.matched.map((m, i) => (
                <div key={i} className="grid grid-cols-4 gap-2 py-0.5 text-xs">
                  <span>{m.dealerName}</span>
                  <span className="text-muted-foreground">{m.officerName}</span>
                  <span className="text-right tabular-nums">{fmt(m.receipt)}</span>
                  <span className="text-right tabular-nums">{fmt(m.srCr)}</span>
                </div>
              ))}
            </Section>

            {analysis.skipped.length > 0 && (
              <Section title={`Skipped Dealers (${analysis.skipped.length})`}>
                {analysis.skipped.map((s, i) => (
                  <div key={i} className="flex flex-wrap justify-between gap-2 py-0.5 text-xs"><span>{s.dealerName}</span><span className="text-muted-foreground">{s.reason}</span></div>
                ))}
              </Section>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep("upload")}><ArrowLeft className="h-4 w-4" /> Back</Button>
              <Button onClick={() => commitMut.mutate()} disabled={commitMut.isPending || analysis.matched.length === 0}>
                {commitMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</> : <><Check className="h-4 w-4" /> Import {analysis.matched.length} dealer(s)</>}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 font-medium text-success"><Check className="h-5 w-5" /> Day Book imported for {result.monthName} — {result.dealersUpdated} dealer(s) updated (Receipts {fmt(result.receiptTotal)}, SR/CR {fmt(result.srCrTotal)}).</p>
            <Button variant="outline" onClick={() => { setStep("upload"); setFile(null); setAnalysis(null); setResult(null); }}>Upload another</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-md border" open>
      <summary className="flex cursor-pointer list-none items-center gap-1 p-2 text-xs font-medium">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" /> {title}
      </summary>
      <div className="space-y-0.5 border-t px-3 py-2">{children}</div>
    </details>
  );
}
function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className={warn ? "font-semibold tabular-nums text-warning" : "font-semibold tabular-nums"}>{value}</p>
    </div>
  );
}
