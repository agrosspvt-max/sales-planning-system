"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Trash2, AlertTriangle, Plus } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DealerCoveragePanel } from "./dealer-coverage-panel";
import { DealerDialog } from "./create-dealer-dialog";

interface AliasRow {
  id: string;
  tallyName: string;
  systemDealerName: string;
  updatedAt: string;
}
interface UploadResult {
  createdDealers: number;
  existingDealers: number;
  aliasesAdded: number;
  addedToSeasonalPlans: number;
  skipped: number;
  errors: number;
  errorDetails: string[];
  totalRows: number;
}

/**
 * Dealer Alias — maps Tally dealer spellings to system dealers so Sales Upload resolves them
 * before name matching. Download a sample, upload the mapping sheet, and review saved aliases.
 */
export function DealerAliasPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery<AliasRow[]>({
    queryKey: ["dealer-alias"],
    queryFn: () => api.get<AliasRow[]>("/api/dealer-alias"),
  });

  const uploadMut = useMutation({
    mutationFn: async (f: File) => {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch("/api/dealer-alias", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Upload failed");
      return body as UploadResult;
    },
    onSuccess: (r) => {
      setResult(r);
      setError(null);
      qc.invalidateQueries({ queryKey: ["dealer-alias"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.del(`/api/dealer-alias/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dealer-alias"] }),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dealer Alias"
        subtitle="Map Tally dealer names to system dealers. Sales Upload always checks these aliases before exact / loose / fuzzy matching."
      />

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Upload alias mapping</CardTitle>
          <Button variant="outline" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Create Dealer</Button>
          <DealerDialog open={createOpen} onOpenChange={setCreateOpen} />
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Columns: <span className="font-medium">Dealer Name</span>, <span className="font-medium">Dealer Alias</span>, <span className="font-medium">Group</span>, <span className="font-medium">Sales Officer</span>, <span className="font-medium">Territory</span> (optional), <span className="font-medium">Add To Active Seasonal Plan</span> (Yes/No). Existing dealers get the alias only; new dealers are created, assigned, and aliased.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant="outline">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API file-download endpoint, not a page route */}
              <a href="/api/dealer-alias/sample"><Download className="h-4 w-4" /> Download Sample Excel</a>
            </Button>
            <input
              type="file"
              accept=".xlsx,.xls"
              className="block text-sm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadMut.mutate(f);
              }}
            />
            {uploadMut.isPending && <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Saving…</span>}
          </div>
          {result && (
            <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>Created Dealers: <span className="font-medium">{result.createdDealers}</span></span>
                <span>Existing Dealers: <span className="font-medium">{result.existingDealers}</span></span>
                <span>Aliases Added: <span className="font-medium">{result.aliasesAdded}</span></span>
                <span>Added To Seasonal Plans: <span className="font-medium">{result.addedToSeasonalPlans}</span></span>
                <span>Skipped: <span className="font-medium">{result.skipped}</span></span>
                <span className={result.errors > 0 ? "text-destructive" : undefined}>Errors: <span className="font-medium">{result.errors}</span></span>
                <span className="text-muted-foreground">({result.totalRows} rows)</span>
              </div>
              {result.errorDetails.length > 0 && (
                <div className="mt-1 flex items-start gap-1 text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                  <span>{result.errorDetails.slice(0, 15).join(" · ")}{result.errorDetails.length > 15 ? ` … (+${result.errorDetails.length - 15} more)` : ""}</span>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <DealerCoveragePanel />

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>System Dealer</TableHead>
              <TableHead>Tally Dealer</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Remove</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (data?.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={4} className="py-10 text-center text-muted-foreground">No dealer aliases yet.</TableCell></TableRow>
            ) : (
              data!.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.systemDealerName}</TableCell>
                  <TableCell>{a.tallyName}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(a.updatedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => deleteMut.mutate(a.id)} disabled={deleteMut.isPending}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
