"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus, Loader2, AlertTriangle, ArrowRight, ArrowLeft, Check } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [step, setStep] = useState<"upload" | "review">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [seasonMonthId, setSeasonMonthId] = useState("");
  const [cutoffDate, setCutoffDate] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: months } = useQuery<{ id: string; label: string }[]>({
    queryKey: ["sales-upload-months"],
    queryFn: () => api.get("/api/sales-upload/months"),
    enabled: open,
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

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: isCreate ? "Create New Plan" : "View Approved Plans" }, { label: "Recovery Planning" }]}
        title="Recovery Planning"
        subtitle={isCreate ? "Draft & returned recovery plans. Upload the Aging Report to initialise a month." : "Approved recovery plans (read-only)."}
        actions={
          isAdmin && isCreate ? (
            <Button onClick={openWizard}><Plus className="h-4 w-4" /> Create New Recovery Plan</Button>
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
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}
