import type { SeasonalParseResult } from "@/features/import/seasonal/service.server";

/**
 * Import diagnostics for Company Onboarding (transparency only — no business logic).
 * Turns the seasonal parse result into an auditable report: every row that is not
 * imported is listed with a clear reason, plus warnings and statistics. No calculation
 * or planning behaviour is affected.
 */

export interface SkippedRow {
  worksheet: string;
  dealer: string;
  product: string;
  pack: string | null;
  quantity: number;
  reason: string;
}

export interface WarningItem {
  type: string;
  message: string;
}

export interface ImportStatistics {
  rowsParsed: number;
  rowsImported: number;
  rowsSkipped: number;
  rowsMatched: number; // rows whose product matched a master
  rowsIgnored: number; // matched product but no quantity anywhere
  packCellsImported: number;
  packCellsSkipped: number; // quantity present but pack size not in master
}

export interface WorkbookSummary {
  packSizes: { total: number; existing: number; created: number };
  products: { total: number; matched: number; created: number };
  dealers: { total: number; matched: number; created: number };
  planningRows: { parsed: number; imported: number; skipped: number };
  monthlyRows: number;
  totalSeasonalQuantity: number;
  totalMonthlyQuantity: number;
}

export interface OnboardingReport {
  /** Schema version of this document. See report/schema.ts (CURRENT_REPORT_VERSION). */
  version: number;
  workbookName: string;
  summary: WorkbookSummary;
  createdMasters: {
    packSizes: string[];
    products: string[];
    dealers: string[];
    officer: string | null;
    season: string | null;
  };
  matchedMasters: { products: number; dealers: number; officers: number };
  skippedRows: SkippedRow[];
  warnings: WarningItem[];
  statistics: ImportStatistics;
  planId: string | null;
  seasonId: string;
}

/**
 * NOTE: reading persisted reports (version detection → migration → normalization →
 * validation) lives in ./report. This module only defines the report shape and builds a
 * fresh report from a parse result; it does not load stored documents.
 */

export interface RowDiagnostics {
  skippedRows: SkippedRow[];
  warnings: WarningItem[];
  statistics: ImportStatistics;
  planningRows: { parsed: number; imported: number; skipped: number };
  monthlyRows: number;
  totalSeasonalQuantity: number;
  totalMonthlyQuantity: number;
}

/**
 * Walk the parsed workbook and classify every row. `products` (from the PRICELIST adapter)
 * is used only to surface missing Rate / NBV warnings — never to invent values.
 */
export function buildImportDiagnostics(
  parse: SeasonalParseResult,
  products: { name: string; rate: number; nbvPercent: number }[],
): RowDiagnostics {
  const skippedRows: SkippedRow[] = [];
  const warnings: WarningItem[] = [];
  const stats: ImportStatistics = {
    rowsParsed: 0,
    rowsImported: 0,
    rowsSkipped: 0,
    rowsMatched: 0,
    rowsIgnored: 0,
    packCellsImported: 0,
    packCellsSkipped: 0,
  };
  let monthlyRows = 0;
  let totalSeasonalQuantity = 0;
  let totalMonthlyQuantity = 0;

  // Track distinct problems for deduped warnings.
  const unknownProducts = new Map<string, number>();
  const unknownPacks = new Map<string, number>();

  for (const d of parse.dealers) {
    // Whole-sheet skips first.
    if (!d.dealerId || d.duplicate) {
      const reason = d.duplicate
        ? `Duplicate dealer sheet (already imported as "${d.dealerName}")`
        : "Dealer not found in Dealer Master";
      warnings.push({
        type: d.duplicate ? "Duplicate Dealer" : "Unknown Dealer",
        message: `Sheet "${d.sheetName}" — ${reason}. All ${d.rows.length} rows skipped.`,
      });
      for (const r of d.rows) {
        stats.rowsParsed++;
        stats.rowsSkipped++;
        const packs = r.packs.filter((p) => p.quantity > 0);
        if (packs.length === 0) {
          skippedRows.push({ worksheet: d.sheetName, dealer: d.dealerName, product: r.productName, pack: null, quantity: 0, reason });
        } else {
          for (const p of packs) {
            skippedRows.push({ worksheet: d.sheetName, dealer: d.dealerName, product: r.productName, pack: p.header, quantity: p.quantity, reason });
          }
        }
      }
      continue;
    }

    // Row-level classification for a matched, non-duplicate dealer.
    for (const r of d.rows) {
      stats.rowsParsed++;

      if (!r.productId) {
        stats.rowsSkipped++;
        unknownProducts.set(r.productName, (unknownProducts.get(r.productName) ?? 0) + 1);
        const reason = "Product not found in Product Master / PRICELIST";
        const packs = r.packs.filter((p) => p.quantity > 0);
        if (packs.length === 0) {
          const monthQty = r.monthlyPlan.reduce((s, q) => s + q, 0);
          skippedRows.push({ worksheet: d.sheetName, dealer: d.dealerName, product: r.productName, pack: null, quantity: monthQty, reason });
        } else {
          for (const p of packs) {
            skippedRows.push({ worksheet: d.sheetName, dealer: d.dealerName, product: r.productName, pack: p.header, quantity: p.quantity, reason });
          }
        }
        continue;
      }

      // Product matched.
      stats.rowsMatched++;
      let importedSomething = false;
      for (const p of r.packs) {
        if (p.quantity <= 0) continue;
        if (p.packSizeId) {
          stats.packCellsImported++;
          totalSeasonalQuantity += p.quantity;
          importedSomething = true;
        } else {
          stats.packCellsSkipped++;
          unknownPacks.set(p.header, (unknownPacks.get(p.header) ?? 0) + 1);
          skippedRows.push({
            worksheet: d.sheetName,
            dealer: d.dealerName,
            product: r.productName,
            pack: p.header,
            quantity: p.quantity,
            reason: "Pack size not found in Pack Size Master",
          });
        }
      }
      for (const q of r.monthlyPlan) {
        if (q > 0) {
          monthlyRows++;
          totalMonthlyQuantity += q;
          importedSomething = true;
        }
      }
      if (importedSomething) stats.rowsImported++;
      else stats.rowsIgnored++;
    }
  }

  // Deduped warnings.
  for (const [name, count] of unknownProducts) {
    warnings.push({ type: "Unknown Product", message: `Product "${name}" is not in the PRICELIST — referenced by ${count} row(s); skipped.` });
  }
  for (const [header, count] of unknownPacks) {
    warnings.push({ type: "Unknown Pack Size", message: `Pack column "${header}" did not match a pack size — ${count} quantity cell(s) skipped.` });
  }
  for (const p of products) {
    if (!(p.rate > 0)) warnings.push({ type: "Missing Product Rate", message: `Product "${p.name}" has no Rate in the PRICELIST (amount will be 0).` });
    if (!(p.nbvPercent > 0)) warnings.push({ type: "Missing NBV", message: `Product "${p.name}" has no NBV% in the PRICELIST (NBV will be 0).` });
  }
  for (const sheet of parse.skippedSheets) {
    warnings.push({ type: "Header Detection", message: `Sheet "${sheet}" produced no readable planning rows (header not detected or empty); skipped.` });
  }

  return {
    skippedRows,
    warnings,
    statistics: stats,
    planningRows: { parsed: stats.rowsParsed, imported: stats.rowsImported, skipped: stats.rowsSkipped },
    monthlyRows,
    totalSeasonalQuantity,
    totalMonthlyQuantity,
  };
}
