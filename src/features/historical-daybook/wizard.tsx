"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { useLabel } from "@/features/labels/label-ui";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { MONTH_NAMES } from "@/lib/season-months";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import type { HistoricalAnalysis, HistoricalResult, HistoricalRow, ReceiptReview } from "./types";

const money = (value: number | string) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(value));
const date = (value: string) => value.split("-").reverse().join("/");
const payment = (value: { date: string; amount: number } | null) =>
  value ? `${date(value.date)} · ₹${money(value.amount)}` : "—";
const PAGE = 100;
export function HistoricalDaybookWizard() {
  const title = useLabel("historical_daybook.tab"),
    fileLabel = useLabel("historical_daybook.file"),
    analyzeLabel = useLabel("historical_daybook.analyze"),
    reviewLabel = useLabel("historical_daybook.review"),
    importLabel = useLabel("historical_daybook.import"),
    dateLabel = useLabel("historical_daybook.date"),
    voucherLabel = useLabel("historical_daybook.voucher"),
    decisionLabel = useLabel("historical_daybook.decision"),
    dealerLabel = useLabel("col.dealer"),
    amountLabel = useLabel("col.amount");
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null),
    [analysis, setAnalysis] = useState<HistoricalAnalysis | null>(null),
    [result, setResult] = useState<HistoricalResult | null>(null),
    [reviews, setReviews] = useState<Record<string, ReceiptReview>>({}),
    [dirty, setDirty] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [page, setPage] = useState(0),
    [error, setError] = useState<string | null>(null);
  const { data: dealers = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["historical-daybook-dealers"],
    queryFn: () => api.get("/api/historical-daybook/dealers"),
  });
  async function send<T>(commit: boolean): Promise<T> {
    const form = new FormData();
    form.append("file", file!);
    form.append(
      "data",
      JSON.stringify({
        reviews: Object.values(reviews),
        previewToken: analysis?.previewToken,
        confirmed,
      }),
    );
    const res = await fetch(`/api/historical-daybook/${commit ? "commit" : "analyze"}`, {
      method: "POST",
      body: form,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Import request failed.");
    return body;
  }
  const analyze = useMutation({
    mutationFn: () => send<HistoricalAnalysis>(false),
    onSuccess: (data) => {
      setAnalysis(data);
      setDirty(false);
      setConfirmed(false);
      setResult(null);
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });
  const commit = useMutation({
    mutationFn: () => send<HistoricalResult>(true),
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["recovery-plan"] });
    },
    onError: (e) => {
      setError((e as Error).message);
      setConfirmed(false);
    },
  });
  const busy = analyze.isPending || commit.isPending;
  function decide(row: HistoricalRow, action: "KEEP" | "EXCLUDE", dealerId?: string) {
    setReviews((current) => ({
      ...current,
      [row.rowKey]: {
        rowKey: row.rowKey,
        action,
        dealerId: dealerId || reviews[row.rowKey]?.dealerId || row.dealerId || undefined,
      },
    }));
    setDirty(true);
    setConfirmed(false);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Import multiple months/years of Receipt history for Last Payment only. Sales, Recovery
          totals, Outstanding, Aging and plans are unchanged. No Recovery Month is required.
        </p>
        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        {result ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-success">
              <Check className="h-4 w-4" />
              {result.alreadyImported
                ? "This exact file was already imported."
                : "Historical receipts imported."}
            </p>
            <p className="text-sm">
              {result.imported} retained · {result.excluded} explicitly excluded ·{" "}
              {result.duplicates} confirmed duplicates. Batch: {result.importId}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setFile(null);
                setAnalysis(null);
                setReviews({});
                setResult(null);
                setConfirmed(false);
                setPage(0);
              }}
            >
              Upload another
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label>{fileLabel} (.xlsx)</Label>
              <input
                type="file"
                accept=".xlsx"
                disabled={busy}
                className="block text-sm"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setAnalysis(null);
                  setReviews({});
                  setConfirmed(false);
                  setError(null);
                  setPage(0);
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Maximum 25 MB / 20,000 rows. Uses the existing Day Book sheet selection. Distinct
              same-day receipts are retained. Voucher references alone are not assumed unique.
            </p>
            <div className="flex justify-end">
              <Button onClick={() => analyze.mutate()} disabled={!file || busy}>
                {analyze.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {analysis ? reviewLabel : analyzeLabel}
              </Button>
            </div>
            {analysis && (
              <>
                <p className="text-sm">
                  Sheet: {analysis.sheet} · Rows analyzed: {analysis.totalRows} · Non-Receipt/total
                  rows ignored: {analysis.ignoredRows}
                </p>
                {!!analysis.ignoredSheets.length && (
                  <p role="status" className="text-sm text-amber-600">
                    Other sheets are not imported: {analysis.ignoredSheets.join(", ")}. Put the
                    combined transactions in the Day Book sheet.
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  {[
                    ["Receipt rows", analysis.summary.receipts],
                    ["Valid receipts", analysis.summary.valid],
                    ["Matched dealers to import", analysis.summary.dealers],
                    ["Unmatched/unconfirmed", analysis.summary.unmatched],
                    ["Invalid rows", analysis.summary.invalid],
                    ["Needs review", analysis.summary.review],
                    ["Confirmed duplicates", analysis.summary.duplicates],
                    ["Explicit exclusions", analysis.summary.excluded],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-md border p-2">
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <p className="font-medium">{value}</p>
                    </div>
                  ))}
                </div>
                {analysis.alreadyImported && (
                  <p className="text-sm text-amber-600">
                    This exact file is already committed. It will not create another batch or
                    receipt. To include previously excluded rows, use a deliberately revised file
                    and review its overlap.
                  </p>
                )}
                {dirty && (
                  <p role="status" className="text-sm text-amber-600">
                    Review changed. Click {reviewLabel} to revalidate and refresh Last Payment
                    impact before confirming.
                  </p>
                )}
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Source row</TableHead>
                        <TableHead>{dealerLabel}</TableHead>
                        <TableHead>{dateLabel}</TableHead>
                        <TableHead>{amountLabel}</TableHead>
                        <TableHead>{voucherLabel}</TableHead>
                        <TableHead>{decisionLabel}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analysis.rows.slice(page * PAGE, (page + 1) * PAGE).map((r) => (
                        <TableRow key={r.rowKey}>
                          <TableCell>{r.sourceOrder}</TableCell>
                          <TableCell className="min-w-[240px]">
                            <p className="text-xs text-muted-foreground">
                              {r.party || "Missing dealer name"}
                            </p>
                            <NativeSelect
                              aria-label={`Dealer for source row ${r.sourceOrder}`}
                              dealerOptions
                              placeholder="Select existing dealer…"
                              disabled={busy || analysis.alreadyImported}
                              options={dealers.map((d) => ({ value: d.id, label: d.name }))}
                              value={reviews[r.rowKey]?.dealerId ?? r.dealerId ?? ""}
                              onChange={(e) => decide(r, "KEEP", e.target.value)}
                            />
                            {!!r.candidates.length && (
                              <p className="text-xs text-muted-foreground">
                                Candidates:{" "}
                                {r.candidates.map((c) => `${c.name} (${c.matchType})`).join(", ")}
                              </p>
                            )}
                          </TableCell>
                          <TableCell>{r.date ? date(r.date) : "Invalid"}</TableCell>
                          <TableCell>{r.amount ? `₹${money(r.amount)}` : "Invalid"}</TableCell>
                          <TableCell>{r.voucherNumber ?? "—"}</TableCell>
                          <TableCell className="min-w-[260px]">
                            {r.errors.map((message) => (
                              <p key={message} className="text-xs text-destructive">
                                {message}
                              </p>
                            ))}
                            {r.reviewReasons.map((message) => (
                              <p key={message} className="text-xs text-amber-600">
                                {message}
                              </p>
                            ))}
                            {r.duplicate ? (
                              <span className="text-xs">Confirmed duplicate</span>
                            ) : (
                              <NativeSelect
                                aria-label={`Decision for source row ${r.sourceOrder}`}
                                disabled={busy || analysis.alreadyImported}
                                placeholder="Choose review decision…"
                                options={[
                                  { value: "KEEP", label: "Keep as a distinct receipt" },
                                  { value: "EXCLUDE", label: "Explicitly exclude this row" },
                                ]}
                                value={reviews[r.rowKey]?.action ?? (r.excluded ? "EXCLUDE" : "")}
                                onChange={(e) => decide(r, e.target.value as "KEEP" | "EXCLUDE")}
                              />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {analysis.rows.length > PAGE && (
                  <div className="flex items-center gap-3 text-sm">
                    <Button
                      variant="outline"
                      disabled={page === 0}
                      onClick={() => setPage(page - 1)}
                    >
                      Previous
                    </Button>
                    Page {page + 1} / {Math.ceil(analysis.rows.length / PAGE)}
                    <Button
                      variant="outline"
                      disabled={(page + 1) * PAGE >= analysis.rows.length}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                )}
                <details open className="rounded-md border p-3">
                  <summary className="text-sm font-medium">
                    Last Payment changes for existing recovery months ({analysis.changes.length})
                  </summary>
                  <p className="py-2 text-xs text-muted-foreground">
                    Receipt eligibility uses the calendar month-end of each recovery period, not its aging cutoff.
                    No plans are created or changed. Equal-date ties retain the existing regular
                    value; otherwise the first retained source row wins. Amounts are never summed.
                  </p>
                  {!!analysis.unresolvedPeriods.length && (
                    <p role="status" className="pb-2 text-xs text-amber-600">
                      Last Payment cannot be projected for {analysis.unresolvedPeriods.length} existing
                      plan(s) with unresolved calendar month/year. Their Last Payment remains blank;
                      valid receipt history can still be imported.
                    </p>
                  )}
                  {analysis.changes.length ? (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{dealerLabel}</TableHead>
                            <TableHead>Recovery month / Plans</TableHead>
                            <TableHead>Previous Last Payment</TableHead>
                            <TableHead>Projected Last Payment</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {analysis.changes.map((c) => (
                            <TableRow key={`${c.dealerId}:${c.calendarYear}:${c.calendarMonth}`}>
                              <TableCell>
                                <DealerName id={c.dealerId} name={c.dealerName} />
                              </TableCell>
                              <TableCell>
                                {MONTH_NAMES[c.calendarMonth - 1]} {c.calendarYear} / {c.plans}
                              </TableCell>
                              <TableCell>{payment(c.before)}</TableCell>
                              <TableCell>{payment(c.after)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No current plan values would change. Valid receipts are still retained for
                      applicable existing/future recovery-month lookups.
                    </p>
                  )}
                </details>
                <Label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={dirty || busy || !(analysis.canCommit || analysis.alreadyImported)}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I confirm these receipts and exclusions. This import affects Last Payment only.
                </Label>
                <div className="flex justify-end">
                  <Button
                    onClick={() => commit.mutate()}
                    disabled={
                      !confirmed ||
                      dirty ||
                      busy ||
                      !(analysis.canCommit || analysis.alreadyImported)
                    }
                  >
                    {commit.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    {importLabel}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
