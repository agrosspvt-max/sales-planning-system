"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus, Loader2, AlertTriangle, ArrowRight, ArrowLeft, Check, RefreshCw } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/features/planning/status-badge";
import type { PlanStatus } from "@/features/planning/types";

export type RecoveryMode = "create" | "view";

interface RecoveryPlanRow {
  id: string;
  seasonName: string;
  monthName: string;
  officerId: string;
  officerName: string;
  status: PlanStatus;
  cutoffDate: string;
  updatedAt: string;
}
interface Analysis {
  workbookName: string;
  seasonName: string;
  monthName: string;
  dealersFound: number;
  billsParsed: number;
  officersAffected: number;
  unknownDealers: string[];
  unassignedDealers: string[];
  totals: { outstanding: number; overdue: number; due: number; running: number };
}
interface UpdateAnalysis {
  seasonName: string;
  monthName: string;
  plansMatched: number;
  officersAffected: number;
  dealersInReport: number;
  unknownDealers: string[];
  unassignedDealers: string[];
  reportTotals: { outstanding: number; overdue: number; due: number; running: number };
  currentTotals: { outstanding: number; overdue: number; due: number; running: number };
}
interface UpdateResult {
  updatedPlans: number;
  skippedPlans: number;
  skipped: { officerName: string; reason: string }[];
  dealersRefreshed: number;
  totalOutstandingDelta: number;
}

const CREATE_STATUSES = "DRAFT,RETURNED";
const VIEW_STATUSES = "APPROVED";
const fmt = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);

/**
 * Recovery Planning — the third planning module, mirroring Sales Planning's Create/View split.
 * Create shows Draft/Returned recovery plans and lets an admin upload the Aging Report to
 * initialise per-officer plans; View shows Approved recovery plans (read-only).
 */
export function RecoveryPlanning({ role, mode }: { role: Role; mode: RecoveryMode }) {
  const qc = useQueryClient();
  const isAdmin = role === Role.SUPER_ADMIN;
  const isOfficer = role === Role.SALES_OFFICER;
  const isCreate = mode === "create";
  const statuses = isCreate ? CREATE_STATUSES : VIEW_STATUSES;

  const { data: plans, isLoading } = useQuery<RecoveryPlanRow[]>({
    queryKey: ["recovery-plans", statuses],
    queryFn: () => api.get<RecoveryPlanRow[]>(`/api/recovery/plans?status=${statuses}`),
  });

  // ---- Create wizard ----
  const [open, setOpen] = useState(false);
  const [uOpen, setUOpen] = useState(false); // Update Recovery wizard (declared early — months query depends on it)
  const [step, setStep] = useState<"upload" | "review">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [seasonMonthId, setSeasonMonthId] = useState("");
  const [cutoffDate, setCutoffDate] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: months } = useQuery<{ id: string; label: string }[]>({
    queryKey: ["sales-upload-months"],
    queryFn: () => api.get("/api/sales-upload/months"),
    enabled: open || uOpen,
  });
  const dataPayload = () => JSON.stringify({ seasonMonthId, cutoffDate });

  const analyzeMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append("data", dataPayload());
      const res = await fetch("/api/recovery/analyze", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Analysis failed");
      return body as Analysis;
    },
    onSuccess: (a) => { setAnalysis(a); setStep("review"); setError(null); },
    onError: (e) => setError((e as Error).message),
  });
  const createMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      form.append("data", dataPayload());
      const res = await fetch("/api/recovery/create", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Create failed");
      return body;
    },
    onSuccess: () => { setOpen(false); resetWizard(); qc.invalidateQueries({ queryKey: ["recovery-plans", statuses] }); },
    onError: (e) => setError((e as Error).message),
  });

  function resetWizard() { setStep("upload"); setFile(null); setSeasonMonthId(""); setCutoffDate(""); setAnalysis(null); setError(null); }
  function openWizard() { resetWizard(); setOpen(true); }

  // ---- Update Recovery wizard (refresh business data of existing plans, never create) ----
  const [uStep, setUStep] = useState<"upload" | "review" | "done">("upload");
  const [uFile, setUFile] = useState<File | null>(null);
  const [uMonthId, setUMonthId] = useState("");
  const [uCutoff, setUCutoff] = useState("");
  const [uAnalysis, setUAnalysis] = useState<UpdateAnalysis | null>(null);
  const [uResult, setUResult] = useState<UpdateResult | null>(null);
  const [uError, setUError] = useState<string | null>(null);
  const uPayload = () => JSON.stringify({ seasonMonthId: uMonthId, cutoffDate: uCutoff });

  const analyzeUpdateMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", uFile as File);
      form.append("data", uPayload());
      const res = await fetch("/api/recovery/update/analyze", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Analysis failed");
      return body as UpdateAnalysis;
    },
    onSuccess: (a) => { setUAnalysis(a); setUStep("review"); setUError(null); },
    onError: (e) => setUError((e as Error).message),
  });
  const updateMut = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", uFile as File);
      form.append("data", uPayload());
      const res = await fetch("/api/recovery/update", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Update failed");
      return body as UpdateResult;
    },
    onSuccess: (r) => { setUResult(r); setUStep("done"); setUError(null); qc.invalidateQueries({ queryKey: ["recovery-plans"] }); qc.invalidateQueries({ queryKey: ["recovery-plan"] }); },
    onError: (e) => setUError((e as Error).message),
  });
  function openUpdate() { setUStep("upload"); setUFile(null); setUMonthId(""); setUCutoff(""); setUAnalysis(null); setUResult(null); setUError(null); setUOpen(true); }

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: isCreate ? "Create New Plan" : "View Approved Plans" }, { label: "Recovery Planning" }]}
        title="Recovery Planning"
        subtitle={isCreate ? "Draft & returned recovery plans. Upload the Aging Report to initialise a month." : "Approved recovery plans (read-only)."}
        actions={
          isAdmin && isCreate ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={openUpdate}><RefreshCw className="h-4 w-4" /> Update Recovery</Button>
              <Button onClick={openWizard}><Plus className="h-4 w-4" /> Create New Recovery Plan</Button>
            </div>
          ) : undefined
        }
      />

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              <TableHead>Month</TableHead>
              {!isOfficer && <TableHead>Sales Officer</TableHead>}
              <TableHead>Cutoff</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (plans?.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">{isCreate ? "No draft or returned recovery plans." : "No approved recovery plans."}</TableCell></TableRow>
            ) : (
              plans!.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.seasonName}</TableCell>
                  <TableCell>{p.monthName}</TableCell>
                  {!isOfficer && <TableCell>{p.officerName}</TableCell>}
                  <TableCell className="text-muted-foreground">{formatDate(p.cutoffDate)}</TableCell>
                  <TableCell><StatusBadge status={p.status} /></TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="outline" size="sm"><Link href={`/planning/recovery/${p.id}`}>Open</Link></Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Create New Recovery Plan</DialogTitle></DialogHeader>
          {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{error}</div>}

          {step === "upload" ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Month</Label>
                <NativeSelect placeholder="Choose the recovery month…" options={(months ?? []).map((m) => ({ value: m.id, label: m.label }))} value={seasonMonthId} onChange={(e) => setSeasonMonthId(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Cutoff Date</Label>
                <Input type="date" value={cutoffDate} onChange={(e) => setCutoffDate(e.target.value)} />
                <p className="text-xs text-muted-foreground">Bills due before this date = Overdue; due within its month = Due; later = Running O/S.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Aging Report (Bills Receivable .xlsx)</Label>
                <input type="file" accept=".xlsx,.xls" className="block text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
              </div>
              <div className="flex justify-end">
                <Button onClick={() => analyzeMut.mutate()} disabled={!file || !seasonMonthId || !cutoffDate || analyzeMut.isPending}>
                  {analyzeMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing…</> : <><ArrowRight className="h-4 w-4" /> Analyze</>}
                </Button>
              </div>
            </div>
          ) : analysis ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{analysis.seasonName} · {analysis.monthName}</p>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <Stat label="Dealers" value={String(analysis.dealersFound)} />
                <Stat label="Bills" value={String(analysis.billsParsed)} />
                <Stat label="Officers affected" value={String(analysis.officersAffected)} />
                <Stat label="Outstanding" value={fmt(analysis.totals.outstanding)} />
                <Stat label="Overdue" value={fmt(analysis.totals.overdue)} />
                <Stat label="Due" value={fmt(analysis.totals.due)} />
              </div>
              {(analysis.unknownDealers.length > 0 || analysis.unassignedDealers.length > 0) && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                  <p className="flex items-center gap-1 font-medium"><AlertTriangle className="h-4 w-4" /> Skipped</p>
                  {analysis.unknownDealers.length > 0 && <p>{analysis.unknownDealers.length} unmatched dealer(s) — add a Dealer Alias.</p>}
                  {analysis.unassignedDealers.length > 0 && <p>{analysis.unassignedDealers.length} matched dealer(s) with no Sales Officer assignment.</p>}
                </div>
              )}
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep("upload")}><ArrowLeft className="h-4 w-4" /> Back</Button>
                <Button onClick={() => createMut.mutate()} disabled={createMut.isPending || analysis.dealersFound === 0}>
                  {createMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</> : <><Check className="h-4 w-4" /> Create {analysis.officersAffected} plan(s)</>}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Update Recovery — refresh aging/business data of existing plans (never creates a plan). */}
      <Dialog open={uOpen} onOpenChange={setUOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Update Recovery (refresh Aging)</DialogTitle></DialogHeader>
          {uError && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{uError}</div>}
          {uStep === "done" && uResult ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <Stat label="Updated Plans" value={String(uResult.updatedPlans)} />
                <Stat label="Skipped Plans" value={String(uResult.skippedPlans)} />
                <Stat label="Dealers refreshed" value={String(uResult.dealersRefreshed)} />
                <div className="rounded-md border p-2">
                  <p className="text-xs uppercase text-muted-foreground">Outstanding change</p>
                  <p className="font-semibold"><DeltaText value={uResult.totalOutstandingDelta} /></p>
                </div>
              </div>
              {uResult.skipped.length > 0 && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
                  <p className="flex items-center gap-1 font-medium text-warning"><AlertTriangle className="h-4 w-4" /> Skipped (not modified)</p>
                  <ul className="mt-1 space-y-0.5">
                    {uResult.skipped.map((s, i) => (
                      <li key={i} className="text-muted-foreground"><span className="font-medium text-foreground">{s.officerName}</span> — {s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex justify-end">
                <Button onClick={() => setUOpen(false)}><Check className="h-4 w-4" /> Done</Button>
              </div>
            </div>
          ) : uStep === "upload" ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Refreshes Outstanding / Overdue / Due / Running for every active recovery plan of the selected month. A plan is refreshed only when it matches confidently on Season + Month + Officer + Dealer — others are skipped and listed. Planning values are never changed.</p>
              <div className="space-y-1.5">
                <Label>Month</Label>
                <NativeSelect placeholder="Choose the recovery month…" options={(months ?? []).map((m) => ({ value: m.id, label: m.label }))} value={uMonthId} onChange={(e) => setUMonthId(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Cutoff Date</Label>
                <Input type="date" value={uCutoff} onChange={(e) => setUCutoff(e.target.value)} />
                <p className="text-xs text-muted-foreground">The cutoff&apos;s business week (1–7, 8–14, 15–22, 23–end) locks all earlier weeks.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Latest Aging Report (Bills Receivable .xlsx)</Label>
                <input type="file" accept=".xlsx,.xls" className="block text-sm" onChange={(e) => { setUFile(e.target.files?.[0] ?? null); setUError(null); }} />
              </div>
              <div className="flex justify-end">
                <Button onClick={() => analyzeUpdateMut.mutate()} disabled={!uFile || !uMonthId || !uCutoff || analyzeUpdateMut.isPending}>
                  {analyzeUpdateMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing…</> : <><ArrowRight className="h-4 w-4" /> Analyze</>}
                </Button>
              </div>
            </div>
          ) : uAnalysis ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{uAnalysis.seasonName} · {uAnalysis.monthName}</p>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <Stat label="Plans to refresh" value={String(uAnalysis.plansMatched)} />
                <Stat label="Officers" value={String(uAnalysis.officersAffected)} />
                <Stat label="Outstanding (now)" value={fmt(uAnalysis.currentTotals.outstanding)} />
                <Stat label="Outstanding (report)" value={fmt(uAnalysis.reportTotals.outstanding)} />
              </div>
              <div className="rounded-md border p-2 text-xs">
                Outstanding change:{" "}
                <DeltaText value={uAnalysis.reportTotals.outstanding - uAnalysis.currentTotals.outstanding} />
              </div>
              {(uAnalysis.unknownDealers.length > 0 || uAnalysis.unassignedDealers.length > 0) && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                  <p className="flex items-center gap-1 font-medium"><AlertTriangle className="h-4 w-4" /> Skipped</p>
                  {uAnalysis.unknownDealers.length > 0 && <p>{uAnalysis.unknownDealers.length} unmatched dealer(s).</p>}
                  {uAnalysis.unassignedDealers.length > 0 && <p>{uAnalysis.unassignedDealers.length} matched dealer(s) with no Sales Officer.</p>}
                </div>
              )}
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setUStep("upload")}><ArrowLeft className="h-4 w-4" /> Back</Button>
                <Button onClick={() => updateMut.mutate()} disabled={updateMut.isPending || uAnalysis.plansMatched === 0}>
                  {updateMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Refreshing…</> : <><RefreshCw className="h-4 w-4" /> Refresh {uAnalysis.plansMatched} plan(s)</>}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Business-aware delta: for receivables a DECREASE is good (green), an increase is bad (red). */
function DeltaText({ value }: { value: number }) {
  if (Math.round(value) === 0) return <span className="text-muted-foreground">no change</span>;
  const good = value < 0;
  const cls = good ? "text-success" : "text-destructive";
  return <span className={cls}>{good ? "▼" : "▲"} {value < 0 ? "-" : "+"}{new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.abs(value))}</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}
