"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Upload, Loader2, Check, AlertTriangle, ArrowLeft, ArrowRight } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RecoveryImportWizard } from "@/features/recovery/recovery-import-wizard";

interface ParsedPack {
  header: string;
  packSizeId: string | null;
  quantity: number;
}
interface ParsedRow {
  productName: string;
  productId: string | null;
  packs: ParsedPack[];
  totalQty: number;
  monthlyPlan: number[];
}
type ImportDealerStatus = "EXISTING" | "NEW" | "INVALID";
interface ParsedDealer {
  sheetName: string;
  dealerName: string;
  dealerId: string | null;
  status: ImportDealerStatus;
  duplicate: boolean;
  rows: ParsedRow[];
}
interface ParseResult {
  workbookName: string;
  officerCandidates: { name: string; matches: { id: string; name: string }[] }[];
  dealers: ParsedDealer[];
  counts: {
    dealerCount: number;
    productRows: number;
    existingDealers: number;
    newDealers: number;
    invalidDealers: number;
    missingProducts: number;
    unknownPackSizes: number;
    duplicateDealers: number;
  };
  newDealerNames: string[];
  missingProducts: string[];
  unknownPackSizes: string[];
}
interface SeasonOption {
  id: string;
  name: string;
  year: number;
  status: "OPEN" | "CLOSED";
}
interface Options {
  officers: { id: string; name: string }[];
}
interface CommitResult {
  planId: string;
  dealerCount: number;
  productRows: number;
  existingDealers: number;
  createdDealers: number;
  skippedDealers: number;
}

type Step = "upload" | "configure" | "preview" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "configure", label: "Season & Officer" },
  { key: "preview", label: "Preview & Validate" },
  { key: "done", label: "Done" },
];

export function SeasonalImportWizard() {
  const [step, setStep] = useState<Step>("upload");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [seasonId, setSeasonId] = useState("");
  const [officerId, setOfficerId] = useState("");
  const [mode, setMode] = useState<"SEASONAL_ONLY" | "COMPLETE">("SEASONAL_ONLY");
  const [importAsApproved, setImportAsApproved] = useState(false);
  const [autoCreateNewDealers, setAutoCreateNewDealers] = useState(true);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [recovery, setRecovery] = useState<"offer" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Active (OPEN) seasons only — a CLOSED season cannot be imported into.
  const { data: seasons } = useQuery<SeasonOption[]>({
    queryKey: ["seasons", "active"],
    queryFn: () => api.get<SeasonOption[]>("/api/seasons?active=true"),
  });
  const { data: options } = useQuery<Options>({
    queryKey: ["import-options"],
    queryFn: () => api.get<Options>("/api/import/dealers/options"),
  });

  const openSeasons = (seasons ?? []).filter((s) => s.status === "OPEN");

  const parseMut = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import/seasonal/parse", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to parse workbook");
      return body as ParseResult;
    },
    onSuccess: (p) => {
      setParsed(p);
      const detected = p.officerCandidates.find((c) => c.matches.length > 0);
      if (detected) setOfficerId(detected.matches[0].id);
      setStep("configure");
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  // Existing dealers (matched) always import. NEW dealers import too when auto-create is on — sent
  // with a null id + name so the server onboards them. Invalid/duplicate rows are excluded.
  const commitPayload = useMemo(() => {
    if (!parsed) return null;
    const dealers = parsed.dealers
      .filter((d) => !d.duplicate && d.status !== "INVALID" && (d.status === "EXISTING" || autoCreateNewDealers))
      .map((d) => ({
        dealerId: d.status === "EXISTING" ? (d.dealerId as string) : null,
        dealerName: d.dealerName,
        rows: d.rows
          .filter((r) => r.productId)
          .map((r) => ({
            productId: r.productId as string,
            packs: r.packs
              .filter((p) => p.packSizeId && p.quantity > 0)
              .map((p) => ({ packSizeId: p.packSizeId as string, quantity: p.quantity })),
            monthlyPlan: mode === "COMPLETE" ? r.monthlyPlan : [],
          }))
          .filter((r) => r.packs.length > 0 || r.monthlyPlan.some((q) => q > 0)),
      }))
      .filter((d) => d.rows.length > 0);
    return { seasonId, officerId, mode, importAsApproved, autoCreateNewDealers, workbookName: parsed.workbookName, dealers };
  }, [parsed, seasonId, officerId, mode, importAsApproved, autoCreateNewDealers]);

  const importableDealers = commitPayload?.dealers.length ?? 0;
  const importableRows = commitPayload?.dealers.reduce((s, d) => s + d.rows.length, 0) ?? 0;

  const commitMut = useMutation({
    mutationFn: () => api.post<CommitResult>("/api/import/seasonal/commit", commitPayload),
    onSuccess: (r) => {
      setResult(r);
      setStep("done");
      setRecovery("offer");
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Import Seasonal Plan"
        subtitle="Load a completed planning workbook (.xlsx / .xls) as a Seasonal Plan. Parsed in memory; nothing is written until you confirm."
      />

      {/* Progress indicator */}
      <div className="flex items-center gap-2 text-sm">
        {STEPS.map((s, i) => {
          const active = STEPS.findIndex((x) => x.key === step) >= i;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full border text-xs",
                  active ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
                )}
              >
                {i + 1}
              </span>
              <span className={cn(active ? "font-medium" : "text-muted-foreground")}>{s.label}</span>
              {i < STEPS.length - 1 && <span className="mx-1 text-muted-foreground">→</span>}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {step === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload the planning workbook</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The Price List, Product Plan and Dealer Summary sheets are skipped automatically; every
              dealer sheet is read for products, pack sizes and quantities.
            </p>
            <input
              type="file"
              accept=".xlsx,.xls"
              className="block text-sm"
              onChange={(e) => {
                const file = e.target.files?.[0];
                setError(null);
                if (file) parseMut.mutate(file);
              }}
            />
            {parseMut.isPending && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading workbook…
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {step === "configure" && parsed && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{parsed.workbookName}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label>Season</Label>
                <NativeSelect
                  className="w-64"
                  placeholder="Select an open season…"
                  options={openSeasons.map((s) => ({ value: s.id, label: `${s.name} ${s.year}` }))}
                  value={seasonId}
                  onChange={(e) => setSeasonId(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Sales Officer</Label>
                <NativeSelect
                  className="w-64"
                  placeholder="Select a Sales Officer…"
                  options={(options?.officers ?? []).map((o) => ({ value: o.id, label: o.name }))}
                  value={officerId}
                  onChange={(e) => setOfficerId(e.target.value)}
                />
              </div>
            </div>
            {parsed.officerCandidates.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Detected in filename: {parsed.officerCandidates.map((c) => c.name).join(", ")}
              </p>
            )}

            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">Import mode</p>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="mode" className="mt-1" checked={mode === "SEASONAL_ONLY"} onChange={() => setMode("SEASONAL_ONLY")} />
                <span>
                  <span className="font-medium">Seasonal Planning only</span>
                  <span className="block text-xs text-muted-foreground">Import pack quantities only.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="mode" className="mt-1" checked={mode === "COMPLETE"} onChange={() => setMode("COMPLETE")} />
                <span>
                  <span className="font-medium">Complete Workbook</span>
                  <span className="block text-xs text-muted-foreground">Import pack quantities and existing Monthly plan quantities. Actual sales, live and pending are never imported.</span>
                </span>
              </label>
              <label className="mt-1 flex items-start gap-2 border-t pt-2 text-sm">
                <input type="checkbox" className="mt-1" checked={importAsApproved} onChange={(e) => setImportAsApproved(e.target.checked)} />
                <span>
                  <span className="font-medium">Import as Approved</span>
                  <span className="block text-xs text-muted-foreground">Mark the imported plan Approved &amp; active immediately (this Excel data was already approved in operations). Otherwise it starts as Draft.</span>
                </span>
              </label>
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep("upload")}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button
                disabled={!seasonId || !officerId}
                onClick={() => {
                  setError(null);
                  setStep("preview");
                }}
              >
                Preview <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "preview" && parsed && (
        <div className="space-y-4">
          {/* Import Summary */}
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Existing Dealers" value={parsed.counts.existingDealers} />
            <Stat label="New Dealers" value={parsed.counts.newDealers} />
            <Stat label="Invalid" value={parsed.counts.invalidDealers} warn />
            <Stat label="Product rows" value={parsed.counts.productRows} />
            <Stat label="Missing products" value={parsed.counts.missingProducts} warn />
            <Stat label="Unknown packs" value={parsed.counts.unknownPackSizes} warn />
          </div>

          {/* Onboard new dealers option (default on). */}
          {parsed.counts.newDealers > 0 && (
            <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <input type="checkbox" className="mt-1" checked={autoCreateNewDealers} onChange={(e) => setAutoCreateNewDealers(e.target.checked)} />
              <span>
                <span className="font-medium">Automatically create new dealers during import</span>
                <span className="block text-xs text-muted-foreground">
                  {parsed.counts.newDealers} new dealer(s) will be created in the Dealer Master and assigned to the selected officer before the plan is imported — no manual assignment needed. Uncheck to skip them.
                </span>
              </span>
            </label>
          )}

          {/* Only PRODUCT/pack mismatches are skipped now — unmatched dealers are onboarded, not skipped. */}
          {(parsed.missingProducts.length > 0 || parsed.unknownPackSizes.length > 0) && (
            <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
              <p className="flex items-center gap-1 font-medium text-warning">
                <AlertTriangle className="h-4 w-4" /> These rows will be skipped (unmatched to masters):
              </p>
              {parsed.missingProducts.length > 0 && <p>Products: {parsed.missingProducts.join(", ")}</p>}
              {parsed.unknownPackSizes.length > 0 && <p>Pack sizes: {parsed.unknownPackSizes.join(", ")}</p>}
            </div>
          )}

          <div className="overflow-auto rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dealer (sheet)</TableHead>
                  <TableHead>Dealer</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Matched rows</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parsed.dealers.map((d) => {
                  const matched = d.rows.filter((r) => r.productId && r.packs.some((p) => p.packSizeId && p.quantity > 0)).length;
                  const status = d.duplicate
                    ? { label: "Duplicate — onboard once", variant: "muted" as const }
                    : d.status === "INVALID"
                      ? { label: "🔴 Invalid", variant: "destructive" as const }
                      : d.status === "NEW"
                        ? autoCreateNewDealers
                          ? { label: "🟡 New Dealer (Can be Added)", variant: "secondary" as const }
                          : { label: "New — will skip", variant: "muted" as const }
                        : matched === 0
                          ? { label: "No matched rows", variant: "muted" as const }
                          : { label: "✓ Existing Dealer", variant: "success" as const };
                  return (
                    <TableRow key={d.sheetName}>
                      <TableCell className="font-medium">{d.sheetName}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {d.status === "EXISTING" ? d.dealerName : d.status === "NEW" ? <span className="italic">New: {d.dealerName}</span> : "—"}
                      </TableCell>
                      <TableCell className="text-right">{d.rows.length}</TableCell>
                      <TableCell className="text-right">{matched}</TableCell>
                      <TableCell>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            Ready to import <span className="font-medium">{importableDealers}</span> dealers
            {parsed.counts.newDealers > 0 && autoCreateNewDealers && (
              <> (incl. <span className="font-medium">{parsed.counts.newDealers}</span> new to create)</>
            )}{" "}
            and <span className="font-medium">{importableRows}</span> product rows into the selected season
            as a new draft Seasonal Plan. It then follows the normal approval, monthly planning and
            reporting flow.
          </div>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep("configure")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button onClick={() => commitMut.mutate()} disabled={commitMut.isPending || importableRows === 0}>
              {commitMut.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</>
              ) : (
                <><Upload className="h-4 w-4" /> Import</>
              )}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <Card>
          <CardContent className="space-y-4 py-8">
            <p className="flex items-center gap-2 text-lg font-medium text-success">
              <Check className="h-6 w-6" /> Seasonal plan imported successfully
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Imported Existing Dealers" value={result.existingDealers} />
              <Stat label="Created New Dealers" value={result.createdDealers} />
              <Stat label="Skipped" value={result.skippedDealers} warn />
              <Stat label="Product rows" value={result.productRows} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href={`/planning/${result.planId}`}>Open the plan</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/planning/sales">Back to Sales Planning</Link>
              </Button>
            </div>

            {/* Continue into Recovery from the latest Aging Report (optional). */}
            {recovery === "offer" && (
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-sm font-medium">Would you like to create/update a Recovery Plan from the latest Aging Report?</p>
                <div className="mt-2 flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setRecovery(null)}>Skip</Button>
                  <Button size="sm" onClick={() => setRecovery("import")}>Import Aging Report</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === "done" && result && recovery === "import" && (
        <RecoveryImportWizard fixedScope={{ kind: "SINGLE_FROM_SEASONAL", seasonPlanId: result.planId }} onDone={() => setRecovery(null)} />
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-semibold", warn && value > 0 && "text-warning")}>{value}</p>
    </div>
  );
}
