"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle, ArrowRight, ArrowLeft, Check, RefreshCw, ChevronRight } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/* ------------------------------- Types ---------------------------------- */

type MatchType = "ALIAS" | "EXACT" | "LOOSE" | "FUZZY";
interface DealerLine { name: string; outstanding: number; overdue: number; due: number; running: number; matchType: MatchType | null; score: number | null }
interface SkipLine { name: string; reason: string }
interface OfficerSection {
  officerId: string;
  officerName: string;
  accepted: DealerLine[];
  duplicates: SkipLine[];
  totals: { outstanding: number; overdue: number; due: number; running: number };
  existingRecovery: { id: string; status: string; lifecycleState: string } | null;
  agingDealerCount: number;
  existingDealerCount: number;
  newDealerCount: number;
}
interface Analysis {
  officers: OfficerSection[];
  skipped: { unknown: SkipLine[]; inactive: SkipLine[]; otherOfficer: SkipLine[] };
  summary: { totalRows: number; accepted: number; skipped: number; unknown: number; duplicates: number; inactive: number; assignedToOther: number; newDealers: number };
  newDealerCandidates: string[];
  context: { seasonName: string; monthName: string; scopeKind: "ALL" | "SELECTED" | "SINGLE" | "SINGLE_FROM_SEASONAL" };
}
interface FailedOfficer { officerId: string; officerName: string; reason: string }
interface SkippedOfficer { officerName: string; reason: string }
interface CommitResult { mode: "CREATE" | "UPDATE" | "REPLACE"; officersAffected: number; recoveryPlanIds: string[]; createdDealers: number; failedOfficers: FailedOfficer[]; skippedOfficers?: SkippedOfficer[] }
type Mode = "CREATE" | "UPDATE" | "REPLACE";

/** Fixed single-officer scope (Manage Plans / Seasonal Replace) — no picker shown. */
export type WizardFixedScope =
  | { kind: "SINGLE"; officerId: string }
  | { kind: "SINGLE_FROM_SEASONAL"; seasonPlanId: string };

interface Props {
  /** Single-officer scope with the officer already known. Omit for Recovery-Planning (All/Selected). */
  fixedScope?: WizardFixedScope;
  /** Officer options for the All/Selected picker (Recovery-Planning mode only). */
  officerOptions?: { value: string; label: string }[];
  title?: string;
  onDone?: () => void;
}

const fmt = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);

/**
 * The ONE Recovery Import wizard for every entry point. Upload → rich preview (per-officer accepted /
 * skipped / duplicate + summary card) → optional onboarding (single scope) → Create/Update/Replace.
 * Only the scope varies; parser, Dealer Alias resolution, preview, onboarding and commit are shared.
 */
export function RecoveryImportWizard({ fixedScope, officerOptions, title = "Recovery from Aging Report", onDone }: Props) {
  const qc = useQueryClient();
  const isSingle = !!fixedScope;

  const [step, setStep] = useState<"upload" | "preview" | "done">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [monthId, setMonthId] = useState("");
  const [cutoff, setCutoff] = useState("");
  const [scopeMode, setScopeMode] = useState<"ALL" | "SELECTED">("ALL");
  const [selectedOfficers, setSelectedOfficers] = useState<Set<string>>(new Set());
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [selectedNew, setSelectedNew] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When a multi-officer commit partially fails, a retry is scoped to ONLY the failed officers so the
  // ones that already succeeded are not refreshed again (which would advance their Recovery week).
  const [retryIds, setRetryIds] = useState<string[] | null>(null);

  const { data: months } = useQuery<{ id: string; label: string }[]>({
    queryKey: ["sales-upload-months"],
    queryFn: () => api.get("/api/sales-upload/months"),
  });

  const buildScope = () => {
    if (retryIds) return { kind: "SELECTED" as const, officerIds: retryIds }; // retry: failed officers only
    if (fixedScope) return fixedScope;
    if (scopeMode === "SELECTED") return { kind: "SELECTED" as const, officerIds: [...selectedOfficers] };
    return { kind: "ALL" as const };
  };
  const scopeReady = isSingle || scopeMode === "ALL" || selectedOfficers.size > 0;

  const analyzeMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append("data", JSON.stringify({ scope: buildScope(), seasonMonthId: monthId, cutoffDate: cutoff }));
      const res = await fetch("/api/recovery/import/analyze", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Analysis failed");
      return body as Analysis;
    },
    onSuccess: (a) => {
      setAnalysis(a);
      setRetryIds(null); // fresh analysis → clear any prior retry scoping
      setSelectedNew(new Set()); // onboarding candidates default UNCHECKED (admin curates)
      const anyExisting = a.officers.some((o) => o.existingRecovery);
      setMode(anyExisting ? null : "CREATE"); // existing → admin must choose UPDATE/REPLACE
      setStep("preview");
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  const commitMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append("data", JSON.stringify({ scope: buildScope(), seasonMonthId: monthId, cutoffDate: cutoff, mode, newDealerNames: [...selectedNew] }));
      const res = await fetch("/api/recovery/import/commit", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        // Surface server-side validation detail rather than only the generic label: flatten Zod field
        // issues (`{ field: [msg] }`) into a readable list so the admin sees exactly what was rejected.
        const issues = body.issues
          ? Object.entries(body.issues as Record<string, string[]>).map(([f, msgs]) => `${f}: ${(msgs ?? []).join(", ")}`).join("; ")
          : "";
        throw new Error([body.error ?? "Commit failed", issues].filter(Boolean).join(" — "));
      }
      return body as CommitResult;
    },
    onSuccess: (r) => {
      setResult(r);
      setStep("done");
      setError(null);
      qc.invalidateQueries({ queryKey: ["recovery-plans"] });
      qc.invalidateQueries({ queryKey: ["recovery-plan"] });
    },
    onError: (e) => {
      const msg = (e as Error).message;
      // Onboarding commits separately from the Recovery step. If dealers were selected for onboarding,
      // reassure the admin the partial state is safe and retryable (no technical/DB detail exposed).
      if (selectedNew.size > 0) {
        setError(`${msg}. Some dealer onboarding may have completed, but the Recovery update did not complete. Your data is safe — you can retry the Recovery import; already-onboarded dealers won't be duplicated.`);
      } else {
        setError(`${msg}. No recovery changes were applied — you can safely retry.`);
      }
    },
  });

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    apply(next);
  };

  const anyExisting = useMemo(() => analysis?.officers.some((o) => o.existingRecovery) ?? false, [analysis]);

  return (
    // Height-capped flex column: header stays fixed, only the body scrolls, per-step action rows stay
    // pinned at the bottom (see the `sticky bottom-0` footers below). Layout only — no logic changes.
    <Card className="flex max-h-[calc(90vh-7rem)] flex-col">
      <CardHeader className="shrink-0"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{error}</div>}

        {step === "upload" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Upload the latest Aging Report. Dealers are matched through the shared Dealer Alias system; only in-scope officers&apos; dealers are used.
            </p>

            {!isSingle && (
              <div className="space-y-2 rounded-md border p-3">
                <Label>Recovery Scope</Label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="scope" checked={scopeMode === "ALL"} onChange={() => setScopeMode("ALL")} /> All Sales Officers (default)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="scope" checked={scopeMode === "SELECTED"} onChange={() => setScopeMode("SELECTED")} /> Selected Sales Officers
                </label>
                {scopeMode === "SELECTED" && (
                  <div className="max-h-44 space-y-1 overflow-auto rounded-md border p-2">
                    {(officerOptions ?? []).map((o) => (
                      <label key={o.value} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4" checked={selectedOfficers.has(o.value)} onChange={() => toggle(selectedOfficers, o.value, setSelectedOfficers)} />
                        {o.label}
                      </label>
                    ))}
                    {(officerOptions ?? []).length === 0 && <p className="text-xs text-muted-foreground">No officers available.</p>}
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Recovery Month</Label>
                <NativeSelect placeholder="Choose the month…" options={(months ?? []).map((m) => ({ value: m.id, label: m.label }))} value={monthId} onChange={(e) => setMonthId(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Cutoff Date</Label>
                <Input type="date" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Aging Report (Bills Receivable .xlsx)</Label>
              <input type="file" accept=".xlsx,.xls" className="block text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
            </div>
            <div className="sticky bottom-0 z-10 -mx-6 -mb-6 flex justify-end border-t bg-card px-6 py-3">
              <Button onClick={() => analyzeMut.mutate()} disabled={!file || !monthId || !cutoff || !scopeReady || analyzeMut.isPending}>
                {analyzeMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing…</> : <><ArrowRight className="h-4 w-4" /> Analyze</>}
              </Button>
            </div>
          </div>
        )}

        {step === "preview" && analysis && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{analysis.context.seasonName} · {analysis.context.monthName}</p>

            {/* Summary card — every number is expandable in the sections below. */}
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat label="Total aging rows" value={String(analysis.summary.totalRows)} />
              <Stat label="Accepted" value={String(analysis.summary.accepted)} />
              <Stat label="Skipped" value={String(analysis.summary.skipped)} warn={analysis.summary.skipped > 0} />
              <Stat label="New (unknown)" value={String(analysis.summary.newDealers)} />
              <Stat label="Duplicates" value={String(analysis.summary.duplicates)} warn={analysis.summary.duplicates > 0} />
              <Stat label="Inactive" value={String(analysis.summary.inactive)} warn={analysis.summary.inactive > 0} />
              <Stat label="Assigned to other" value={String(analysis.summary.assignedToOther)} warn={analysis.summary.assignedToOther > 0} />
              <Stat label="Officers in scope" value={String(analysis.officers.length)} />
            </div>

            {/* Per-officer sections. */}
            <div className="space-y-2">
              {analysis.officers.map((o) => (
                <div key={o.officerId} className="rounded-md border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-2 text-sm">
                    <span className="font-medium">{o.officerName}</span>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {/* Reconciliation summary (item 5): Aging | Existing | New dealers to be added. */}
                      <span>Aging <span className="font-medium text-foreground">{o.agingDealerCount}</span></span>
                      <span>Existing <span className="font-medium text-foreground">{o.existingDealerCount}</span></span>
                      <span>New <span className={`font-medium ${o.newDealerCount > 0 ? "text-success" : "text-foreground"}`}>+{o.newDealerCount}</span></span>
                      <span className="text-muted-foreground/70">· O/S {fmt(o.totals.outstanding)} · Overdue {fmt(o.totals.overdue)} · Due {fmt(o.totals.due)}{o.existingRecovery ? " · existing plan" : ""}</span>
                    </span>
                  </div>
                  <div className="space-y-1 p-2">
                    <Section title={`Accepted Dealers (${o.accepted.length})`}>
                      {o.accepted.length === 0 ? <Empty /> : o.accepted.map((d, i) => (
                        <div key={i} className="flex items-center justify-between gap-2 py-0.5 text-xs">
                          <span className="flex items-center gap-1.5">{d.name}{d.matchType && <MatchTag type={d.matchType} score={d.score} />}</span>
                          <span className="tabular-nums text-muted-foreground">O/S {fmt(d.outstanding)}</span>
                        </div>
                      ))}
                    </Section>
                    {o.duplicates.length > 0 && (
                      <Section title={`Duplicate Dealers (${o.duplicates.length})`}>
                        {o.duplicates.map((d, i) => <SkipRow key={i} name={d.name} reason={d.reason} />)}
                      </Section>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Report-level skipped sections (each dealer with an exact reason). */}
            {(analysis.skipped.unknown.length > 0 || analysis.skipped.inactive.length > 0 || analysis.skipped.otherOfficer.length > 0) && (
              <div className="space-y-1 rounded-md border p-2">
                <p className="flex items-center gap-1 text-sm font-medium text-warning"><AlertTriangle className="h-4 w-4" /> Skipped dealers</p>
                {analysis.skipped.unknown.length > 0 && (
                  <Section title={`New / Unknown Dealers (${analysis.skipped.unknown.length})`}>
                    {analysis.skipped.unknown.map((d, i) => <SkipRow key={i} name={d.name} reason={d.reason} />)}
                  </Section>
                )}
                {analysis.skipped.inactive.length > 0 && (
                  <Section title={`Inactive Dealers (${analysis.skipped.inactive.length})`}>
                    {analysis.skipped.inactive.map((d, i) => <SkipRow key={i} name={d.name} reason={d.reason} />)}
                  </Section>
                )}
                {analysis.skipped.otherOfficer.length > 0 && (
                  <Section title={`Assigned to Another Officer (${analysis.skipped.otherOfficer.length})`}>
                    {analysis.skipped.otherOfficer.map((d, i) => <SkipRow key={i} name={d.name} reason={d.reason} />)}
                  </Section>
                )}
              </div>
            )}

            {/* Onboarding — single-officer scopes only (unknown names have no officer otherwise). */}
            {isSingle && analysis.newDealerCandidates.length > 0 && (
              <div className="space-y-1.5 rounded-md border p-3">
                <p className="text-sm font-medium">Onboard new dealers → <span className="text-primary">{analysis.officers[0]?.officerName ?? "this officer"}</span></p>
                <p className="text-xs text-muted-foreground">These names have no Dealer Alias match, so they have no known owner. Select only those that belong to <span className="font-medium">{analysis.officers[0]?.officerName ?? "this officer"}</span> — each selected dealer is created and <span className="font-medium">assigned to {analysis.officers[0]?.officerName ?? "this officer"}</span>, added to the seasonal plan, and included in recovery. Unselected names are left for admin assignment.</p>
                <div className="max-h-52 space-y-1 overflow-auto">
                  {analysis.newDealerCandidates.map((n) => (
                    <label key={n} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="h-4 w-4" checked={selectedNew.has(n)} onChange={() => toggle(selectedNew, n, setSelectedNew)} />
                      {n}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Mode: CREATE when none exist; else the admin must pick UPDATE or REPLACE. */}
            {anyExisting && (
              <div className="space-y-2 rounded-md border border-info/40 bg-info/5 p-3 text-sm">
                <p className="font-medium">A Recovery Plan already exists for {analysis.officers.filter((o) => o.existingRecovery).length} of the in-scope officer(s).</p>
                <label className="flex items-start gap-2"><input type="radio" name="rmode" className="mt-1" checked={mode === "UPDATE"} onChange={() => setMode("UPDATE")} /><span><span className="font-medium">Update existing (recommended)</span><span className="block text-xs text-muted-foreground">Refresh aging values only — officer inputs, weekly plans and approvals are preserved.</span></span></label>
                <label className="flex items-start gap-2"><input type="radio" name="rmode" className="mt-1" checked={mode === "REPLACE"} onChange={() => setMode("REPLACE")} /><span><span className="font-medium">Replace existing</span><span className="block text-xs text-muted-foreground">Reset officer inputs and re-seed from this report. Clears entered planning for the month.</span></span></label>
              </div>
            )}

            <div className="sticky bottom-0 z-10 -mx-6 -mb-6 flex justify-between border-t bg-card px-6 py-3">
              <Button variant="outline" onClick={() => setStep("upload")}><ArrowLeft className="h-4 w-4" /> Back</Button>
              <Button onClick={() => { setRetryIds(null); commitMut.mutate(); }} disabled={commitMut.isPending || !mode || analysis.summary.accepted === 0}>
                {commitMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Working…</> : <>{mode === "UPDATE" ? <RefreshCw className="h-4 w-4" /> : <Check className="h-4 w-4" />} {mode === "UPDATE" ? "Update Recovery" : mode === "REPLACE" ? "Replace Recovery" : "Create Recovery"}</>}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-3">
            <p className={cn("flex items-center gap-2 font-medium", result.officersAffected > 0 ? "text-success" : "text-warning")}>
              <Check className="h-5 w-5" /> Recovery {result.mode === "CREATE" ? "created" : result.mode === "UPDATE" ? "updated" : "replaced"} for {result.officersAffected} officer(s)
              {result.createdDealers > 0 ? ` · ${result.createdDealers} new dealer(s) onboarded` : ""}.
            </p>

            {/* Partial failure — retry ONLY the failed officers, so the ones that succeeded are not
                refreshed again (their Recovery week is not advanced). */}
            {result.failedOfficers.length > 0 && (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <p className="flex items-center gap-1 font-medium text-warning"><AlertTriangle className="h-4 w-4" /> {result.failedOfficers.length} officer(s) did not complete</p>
                <ul className="space-y-0.5">
                  {result.failedOfficers.map((f) => (
                    <li key={f.officerId} className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{f.officerName}</span> — {f.reason}</li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">Retrying affects only these officers — the officers that already succeeded won&apos;t be re-processed.</p>
                <Button
                  size="sm"
                  onClick={() => { setRetryIds(result.failedOfficers.map((f) => f.officerId)); commitMut.mutate(); }}
                  disabled={commitMut.isPending}
                >
                  {commitMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Retrying…</> : <><RefreshCw className="h-4 w-4" /> Retry failed officer(s)</>}
                </Button>
              </div>
            )}

            {/* Skipped officers (UPDATE): intentionally NOT refreshed, each with its exact reason — so a
                low affected-count is explained per-officer rather than looking like a silent failure. */}
            {result.skippedOfficers && result.skippedOfficers.length > 0 && (
              <div className="space-y-1 rounded-md border p-3 text-sm">
                <p className="font-medium">{result.skippedOfficers.length} officer(s) skipped (not updated)</p>
                <ul className="space-y-0.5">
                  {result.skippedOfficers.map((s) => (
                    <li key={s.officerName} className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{s.officerName}</span> — {s.reason}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-wrap justify-end gap-2 border-t bg-card px-6 py-3">
              {result.recoveryPlanIds.length === 1 && <Button asChild><Link href={`/planning/recovery/${result.recoveryPlanIds[0]}`}>Open Recovery Plan</Link></Button>}
              <Button variant="outline" onClick={() => onDone?.()}>Done</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-md border">
      <summary className="flex cursor-pointer list-none items-center gap-1 p-2 text-xs font-medium">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" /> {title}
      </summary>
      <div className="space-y-0.5 border-t px-3 py-2">{children}</div>
    </details>
  );
}
function MatchTag({ type, score }: { type: MatchType; score: number | null }) {
  // ALIAS/EXACT are exact matches (muted); LOOSE/FUZZY are approximate (amber) — FUZZY shows confidence.
  const approx = type === "LOOSE" || type === "FUZZY";
  const label = type === "FUZZY" && score != null ? `FUZZY ${Math.round(score * 100)}%` : type;
  return <span className={cn("rounded px-1 py-0.5 text-[10px] font-medium", approx ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground")}>{label}</span>;
}
function SkipRow({ name, reason }: { name: string; reason: string }) {
  return <div className="flex flex-wrap justify-between gap-2 py-0.5 text-xs"><span>{name}</span><span className="text-muted-foreground">{reason}</span></div>;
}
function Empty() { return <p className="py-0.5 text-xs text-muted-foreground">None.</p>; }
function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className={cn("font-semibold tabular-nums", warn && "text-warning")}>{value}</p>
    </div>
  );
}
