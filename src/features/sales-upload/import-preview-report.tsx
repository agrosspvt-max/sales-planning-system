"use client";

import * as XLSX from "xlsx";
import { ChevronRight, Download, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/* Shapes mirror the server ImportPreviewReport (service is server-only, so types are re-declared). */
type MatchedBy = "Exact" | "Alias" | "Fuzzy";
type ProductStatus = "Imported" | "No Plan Found" | "Product Not Found";
interface RProduct { productName: string; plannedQty: number; importedQty: number; amount: number; rate: number; status: ProductStatus }
interface RDealer { dealerName: string; matchedBy: MatchedBy; originalTallyName: string | null; products: RProduct[] }
interface ROfficer { officerName: string; dealers: RDealer[] }
interface RNotMatched { originalName: string; suggestedMatch: string | null; reason: string }
interface RPlannedNoSales { officerName: string; dealerName: string; productName: string; plannedQty: number }
interface RMatchedNotPlanned { officerId: string; officerName: string; dealerName: string; productId: string; productName: string; salesQty: number; amount: number; rate: number; matchedBy: MatchedBy }
export interface ImportPreviewReportData {
  officers: ROfficer[];
  dealersNotMatched: RNotMatched[];
  productsNotMatched: RNotMatched[];
  plannedNoSales: RPlannedNoSales[];
  matchedNotPlanned: RMatchedNotPlanned[];
  summary: {
    totalOfficers: number; dealersMatched: number; dealersUnmatched: number; productsImported: number;
    productsNotPlanned: number; productsNotMatched: number; rowsImported: number; totalQty: number; totalAmount: number;
  };
}

const n = (v: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(v);
const STATUS_TONE: Record<ProductStatus, string> = {
  Imported: "text-success",
  "No Plan Found": "text-warning",
  "Product Not Found": "text-destructive",
};

/**
 * Verification-only Import Preview Report. Renders exactly what the import WOULD do, grouped by Sales
 * Officer → Dealer → Product, plus the mismatch/validation sections and a summary. "Export Report"
 * writes the whole thing to a single .xlsx (client-side, from the analysis data — no extra request).
 */
/** One selectable auto-add unit: (officer, product). Aggregates the dealers that sold it. */
interface UnplannedGroup { key: string; officerId: string; officerName: string; productId: string; productName: string; matchedBy: MatchedBy; dealers: string[]; qty: number; amount: number }
function groupUnplanned(rows: RMatchedNotPlanned[]): UnplannedGroup[] {
  const m = new Map<string, UnplannedGroup>();
  for (const r of rows) {
    const key = `${r.officerId}|${r.productId}`;
    let g = m.get(key);
    if (!g) { g = { key, officerId: r.officerId, officerName: r.officerName, productId: r.productId, productName: r.productName, matchedBy: r.matchedBy, dealers: [], qty: 0, amount: 0 }; m.set(key, g); }
    g.dealers.push(r.dealerName); g.qty += r.salesQty; g.amount += r.amount;
  }
  return [...m.values()].sort((a, b) => a.officerName.localeCompare(b.officerName) || a.productName.localeCompare(b.productName));
}

interface AutoAddControls {
  autoAdd: boolean;
  onAutoAddChange: (on: boolean) => void;
  selected: Set<string>; // keys "officerId|productId"
  onToggle: (key: string) => void;
}

export function ImportPreviewReport({ report, workbookName, autoAddControls }: { report: ImportPreviewReportData; workbookName?: string; autoAddControls?: AutoAddControls }) {
  const s = report.summary;
  const unplanned = groupUnplanned(report.matchedNotPlanned);

  const exportXlsx = () => {
    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Metric", "Value"],
      ["Total Sales Officers", s.totalOfficers],
      ["Total Dealers Matched", s.dealersMatched],
      ["Total Dealers Unmatched", s.dealersUnmatched],
      ["Total Products Imported", s.productsImported],
      ["Total Products Not Planned", s.productsNotPlanned],
      ["Total Products Not Matched", s.productsNotMatched],
      ["Total Rows Imported", s.rowsImported],
      ["Total Quantity", s.totalQty],
      ["Total Amount", s.totalAmount],
      ["Matched Dealer But Product Not Planned", report.matchedNotPlanned.length],
    ]), "Summary");

    const officerRows: (string | number)[][] = [["Sales Officer", "Dealer", "Matched By", "Original Tally Name", "Product", "Planned Qty", "Imported Qty", "Amount", "Rate", "Status"]];
    for (const o of report.officers)
      for (const d of o.dealers)
        for (const p of d.products)
          officerRows.push([o.officerName, d.dealerName, d.matchedBy, d.originalTallyName ?? "", p.productName, p.plannedQty, p.importedQty, p.amount, p.rate, p.status]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(officerRows), "Sales Officer Report");

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Original Tally Name", "Suggested Match", "Reason"],
      ...report.dealersNotMatched.map((r) => [r.originalName, r.suggestedMatch ?? "", r.reason]),
    ]), "Dealers Not Matched");

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Original Product Name", "Suggested Match", "Reason"],
      ...report.productsNotMatched.map((r) => [r.originalName, r.suggestedMatch ?? "", r.reason]),
    ]), "Products Not Matched");

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Sales Officer", "Dealer", "Product", "Planned Qty"],
      ...report.plannedNoSales.map((r) => [r.officerName, r.dealerName, r.productName, r.plannedQty]),
    ]), "Planned But No Sales");

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Sales Officer", "Dealer", "Product", "Sales Qty", "Amount", "Rate", "Match Type", "Status"],
      ...report.matchedNotPlanned.map((r) => [r.officerName, r.dealerName, r.productName, r.salesQty, r.amount, r.rate, r.matchedBy, "Dealer matched, but product not planned"]),
    ]), "Unplanned Products");

    // Auto Added Products — the (officer, product) units the admin selected to add to the Seasonal Plan.
    const selected = autoAddControls?.autoAdd ? unplanned.filter((g) => autoAddControls.selected.has(g.key)) : [];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Sales Officer", "Product", "Match Type", "Dealers That Sold", "Sales Qty", "Amount"],
      ...selected.map((g) => [g.officerName, g.productName, g.matchedBy, g.dealers.join(", "), g.qty, g.amount]),
    ]), "Auto Added Products");

    const base = (workbookName ?? "Sales Upload").replace(/\.(xlsx|xls)$/i, "");
    XLSX.writeFile(wb, `Import Preview — ${base}.xlsx`);
  };

  return (
    <div className="space-y-3 rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Import Preview Report <span className="font-normal text-muted-foreground">(verification only)</span></h3>
        <Button variant="outline" size="sm" onClick={exportXlsx}><Download className="h-4 w-4" /> Export Report</Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Sales Officers" value={s.totalOfficers} />
        <Stat label="Dealers Matched" value={s.dealersMatched} />
        <Stat label="Dealers Unmatched" value={s.dealersUnmatched} warn={s.dealersUnmatched > 0} />
        <Stat label="Products Imported" value={s.productsImported} good />
        <Stat label="Products Not Planned" value={s.productsNotPlanned} warn={s.productsNotPlanned > 0} />
        <Stat label="Products Not Matched" value={s.productsNotMatched} warn={s.productsNotMatched > 0} />
        <Stat label="Total Quantity" value={s.totalQty} />
        <Stat label="Total Amount" value={s.totalAmount} />
      </div>

      {/* Sales Officer → Dealer → Products */}
      <div className="space-y-1">
        {report.officers.map((o) => (
          <Section key={o.officerName} title={`${o.officerName} · ${o.dealers.length} dealer(s)`}>
            {o.dealers.map((d) => (
              <div key={d.dealerName} className="rounded-md border">
                <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-2 py-1 text-xs">
                  <span className="font-medium">{d.dealerName}</span>
                  <Badge variant="muted" className="text-[10px]">{d.matchedBy}</Badge>
                  {d.originalTallyName && <span className="text-muted-foreground">Tally: “{d.originalTallyName}”</span>}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-left">
                        <th>Product</th><th className="text-right">Planned</th><th className="text-right">Imported</th><th className="text-right">Amount</th><th className="text-right">Rate</th><th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.products.map((p, i) => (
                        <tr key={i} className="border-t [&>td]:px-2 [&>td]:py-0.5">
                          <td>{p.productName}</td>
                          <td className="text-right tabular-nums">{n(p.plannedQty)}</td>
                          <td className="text-right tabular-nums">{n(p.importedQty)}</td>
                          <td className="text-right tabular-nums">{n(p.amount)}</td>
                          <td className="text-right tabular-nums">{n(p.rate)}</td>
                          <td className={cn("font-medium", STATUS_TONE[p.status])}>{p.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </Section>
        ))}
      </div>

      {unplanned.length > 0 && (
        <Section title={`Unplanned Products (${unplanned.length})`} warn>
          <p className="text-[11px] text-muted-foreground">
            Dealer matched and product matched, but the product isn&apos;t in that Sales Officer&apos;s Seasonal Plan — so its actuals can&apos;t import until the product is added to the plan.
          </p>
          {autoAddControls && (
            <label className="mt-1 flex items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs font-medium">
              <input type="checkbox" className="h-4 w-4" checked={autoAddControls.autoAdd} onChange={(e) => autoAddControls.onAutoAddChange(e.target.checked)} />
              Auto add selected products to the Seasonal Plan before importing sales
            </label>
          )}
          <div className="mt-1 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-left">
                  {autoAddControls && <th className="w-6"></th>}
                  <th>Sales Officer</th><th>Product</th><th>Match</th><th>Dealer(s)</th><th className="text-right">Imported Qty</th><th className="text-right">Amount</th><th className="text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {unplanned.map((g) => {
                  const addable = g.officerId !== "";
                  const checked = autoAddControls?.autoAdd && autoAddControls.selected.has(g.key);
                  return (
                    <tr key={g.key} className="border-t [&>td]:px-2 [&>td]:py-0.5">
                      {autoAddControls && (
                        <td>
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            disabled={!autoAddControls.autoAdd || !addable}
                            checked={!!checked}
                            onChange={() => autoAddControls.onToggle(g.key)}
                            title={addable ? "Add this product to the officer's Seasonal Plan" : "This dealer has no approved Seasonal Plan — cannot auto-add"}
                          />
                        </td>
                      )}
                      <td>{g.officerName}</td>
                      <td>{g.productName}</td>
                      <td><Badge variant="muted" className="text-[10px]">{g.matchedBy}</Badge></td>
                      <td className="text-muted-foreground">{g.dealers.join(", ")}</td>
                      <td className="text-right tabular-nums">{n(g.qty)}</td>
                      <td className="text-right tabular-nums">{n(g.amount)}</td>
                      <td className="text-right tabular-nums">{n(g.qty > 0 ? g.amount / g.qty : 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      {report.dealersNotMatched.length > 0 && (
        <Section title={`Dealers Not Matched (${report.dealersNotMatched.length})`} warn>
          <SimpleTable head={["Original Tally Name", "Suggested Match", "Reason"]} rows={report.dealersNotMatched.map((r) => [r.originalName, r.suggestedMatch ?? "—", r.reason])} />
        </Section>
      )}
      {report.productsNotMatched.length > 0 && (
        <Section title={`Products Not Matched (${report.productsNotMatched.length})`} warn>
          <SimpleTable head={["Original Product Name", "Suggested Match", "Reason"]} rows={report.productsNotMatched.map((r) => [r.originalName, r.suggestedMatch ?? "—", r.reason])} />
        </Section>
      )}
      {report.plannedNoSales.length > 0 && (
        <Section title={`Planned Products With No Sales (${report.plannedNoSales.length})`}>
          <SimpleTable head={["Sales Officer", "Dealer", "Product", "Planned Qty"]} rows={report.plannedNoSales.map((r) => [r.officerName, r.dealerName, r.productName, n(r.plannedQty)])} />
        </Section>
      )}
    </div>
  );
}

function Stat({ label, value, good, warn }: { label: string; value: number; good?: boolean; warn?: boolean }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[11px] uppercase text-muted-foreground">{label}</p>
      <p className={cn("font-semibold tabular-nums", good && "text-success", warn && "text-warning")}>{n(value)}</p>
    </div>
  );
}

function Section({ title, children, warn }: { title: string; children: React.ReactNode; warn?: boolean }) {
  return (
    <details className="group rounded-md border">
      <summary className="flex cursor-pointer list-none items-center gap-1 p-2 text-xs font-medium">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
        {warn && <AlertTriangle className="h-3.5 w-3.5 text-warning" />} {title}
      </summary>
      <div className="space-y-1 border-t p-2">{children}</div>
    </details>
  );
}

function SimpleTable({ head, rows, note }: { head: string[]; rows: (string | number)[][]; note?: string }) {
  return (
    <div className="space-y-1">
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-left">{head.map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t [&>td]:px-2 [&>td]:py-0.5">{r.map((c, j) => <td key={j} className={j === 0 ? "" : "tabular-nums"}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
