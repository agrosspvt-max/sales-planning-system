"use client";

import { Download, FileJson, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OnboardingReport } from "./diagnostics";
import type { LoadedReport } from "./report";

/* ------------------------------- exports --------------------------------- */

export function reportToCsv(report: OnboardingReport): string {
  const esc = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines: string[] = [];
  const s = report.summary;
  lines.push("SECTION,field,value");
  const sum: [string, unknown][] = [
    ["Workbook", report.workbookName],
    ["Pack Sizes total", s.packSizes.total],
    ["Pack Sizes created", s.packSizes.created],
    ["Products total", s.products.total],
    ["Products matched", s.products.matched],
    ["Products created", s.products.created],
    ["Dealers total", s.dealers.total],
    ["Dealers matched", s.dealers.matched],
    ["Dealers created", s.dealers.created],
    ["Planning rows parsed", s.planningRows.parsed],
    ["Planning rows imported", s.planningRows.imported],
    ["Planning rows skipped", s.planningRows.skipped],
    ["Monthly rows", s.monthlyRows],
    ["Total seasonal quantity", s.totalSeasonalQuantity],
    ["Total monthly quantity", s.totalMonthlyQuantity],
  ];
  for (const [k, v] of sum) lines.push(`Summary,${esc(k)},${esc(v)}`);
  const st = report.statistics;
  for (const [k, v] of Object.entries(st)) lines.push(`Statistics,${esc(k)},${esc(v)}`);
  for (const n of report.createdMasters.packSizes) lines.push(`Created Pack Size,${esc(n)},`);
  for (const n of report.createdMasters.products) lines.push(`Created Product,${esc(n)},`);
  for (const n of report.createdMasters.dealers) lines.push(`Created Dealer,${esc(n)},`);

  lines.push("");
  lines.push("WARNINGS,type,message");
  for (const w of report.warnings) lines.push(`Warning,${esc(w.type)},${esc(w.message)}`);

  lines.push("");
  lines.push("SKIPPED ROWS,worksheet,dealer,product,pack,quantity,reason");
  for (const r of report.skippedRows) {
    lines.push(`Skipped,${esc(r.worksheet)},${esc(r.dealer)},${esc(r.product)},${esc(r.pack)},${esc(r.quantity)},${esc(r.reason)}`);
  }
  return lines.join("\n");
}

export function downloadReport(report: OnboardingReport, kind: "json" | "csv") {
  const base = (report.workbookName || "onboarding").replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "_");
  const content = kind === "json" ? JSON.stringify(report, null, 2) : reportToCsv(report);
  const blob = new Blob([content], { type: kind === "json" ? "application/json" : "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `onboarding_${base}.${kind}`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------- view ------------------------------------ */

function Section({ title, count, defaultOpen = true, children }: { title: string; count?: number; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details open={defaultOpen} className="rounded-lg border bg-background">
      <summary className="cursor-pointer select-none px-4 py-2 text-sm font-semibold">
        {title}
        {count !== undefined && <span className="ml-2 text-muted-foreground">({count})</span>}
      </summary>
      <div className="border-t p-4">{children}</div>
    </details>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

export function MigrationReportView({ loaded }: { loaded: LoadedReport }) {
  // The loader (version detect → migrate → normalize → validate) guarantees a full,
  // current-schema report, so this view reads fields directly — no optional chaining.
  const { report, ok, errors } = loaded;
  const s = report.summary;
  const cm = report.createdMasters;
  return (
    <div className="space-y-3">
      {!ok && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-4 w-4" /> Invalid Migration Report
          </p>
          <p className="mt-0.5 text-xs">
            This record could not be fully validated and may show incomplete data. The
            available information is rendered below.
          </p>
          {errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {errors.slice(0, 6).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => downloadReport(report, "json")}>
          <FileJson className="h-4 w-4" /> Download JSON
        </Button>
        <Button size="sm" variant="outline" onClick={() => downloadReport(report, "csv")}>
          <Download className="h-4 w-4" /> Download CSV
        </Button>
      </div>

      <Section title="Summary">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Pack Sizes" value={`${s.packSizes.total} (${s.packSizes.created} new)`} />
          <Stat label="Products" value={`${s.products.total} · ${s.products.matched} matched · ${s.products.created} new`} />
          <Stat label="Dealers" value={`${s.dealers.total} · ${s.dealers.matched} matched · ${s.dealers.created} new`} />
          <Stat label="Planning Rows (parsed)" value={s.planningRows.parsed} />
          <Stat label="Imported" value={s.planningRows.imported} />
          <Stat label="Skipped" value={s.planningRows.skipped} />
          <Stat label="Monthly Rows" value={s.monthlyRows} />
          <Stat label="Total Seasonal Qty" value={s.totalSeasonalQuantity} />
          <Stat label="Total Monthly Qty" value={s.totalMonthlyQuantity} />
        </div>
      </Section>

      <Section title="Created Masters">
        <div className="space-y-2 text-sm">
          <p><span className="font-medium">Pack sizes:</span> {cm.packSizes.length ? cm.packSizes.join(", ") : "none (all existed)"}</p>
          <p><span className="font-medium">Products ({cm.products.length}):</span> {cm.products.length ? cm.products.join(", ") : "none (all existed)"}</p>
          <p><span className="font-medium">Dealers ({cm.dealers.length}):</span> {cm.dealers.length ? cm.dealers.join(", ") : "none (all existed)"}</p>
          <p><span className="font-medium">Officer:</span> {cm.officer ?? "matched existing"}</p>
          <p><span className="font-medium">Season:</span> {cm.season ?? "matched existing"}</p>
        </div>
      </Section>

      <Section title="Matched Masters">
        <p className="text-sm">
          {report.matchedMasters.products} products · {report.matchedMasters.dealers} dealers ·{" "}
          {report.matchedMasters.officers} officer(s) matched existing records.
        </p>
      </Section>

      <Section title="Skipped Rows" count={report.skippedRows.length} defaultOpen>
        {report.skippedRows.length === 0 ? (
          <p className="text-sm text-success">No rows skipped — every workbook row was imported.</p>
        ) : (
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Worksheet</TableHead>
                  <TableHead>Dealer</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Pack</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.skippedRows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-muted-foreground">{r.worksheet}</TableCell>
                    <TableCell>{r.dealer}</TableCell>
                    <TableCell className="font-medium">{r.product}</TableCell>
                    <TableCell>{r.pack ?? "—"}</TableCell>
                    <TableCell className="text-right">{r.quantity}</TableCell>
                    <TableCell className="text-warning">{r.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title="Warnings" count={report.warnings.length} defaultOpen={report.warnings.length > 0}>
        {report.warnings.length === 0 ? (
          <p className="text-sm text-success">No warnings.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {report.warnings.map((w, i) => (
              <li key={i} className="flex gap-2">
                <Badge variant="muted">{w.type}</Badge>
                <span className="text-warning">{w.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Statistics" defaultOpen={false}>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Rows Parsed" value={report.statistics.rowsParsed} />
          <Stat label="Rows Imported" value={report.statistics.rowsImported} />
          <Stat label="Rows Skipped" value={report.statistics.rowsSkipped} />
          <Stat label="Rows Matched" value={report.statistics.rowsMatched} />
          <Stat label="Rows Ignored" value={report.statistics.rowsIgnored} />
          <Stat label="Pack Cells Imported" value={report.statistics.packCellsImported} />
          <Stat label="Pack Cells Skipped" value={report.statistics.packCellsSkipped} />
        </div>
      </Section>
    </div>
  );
}
