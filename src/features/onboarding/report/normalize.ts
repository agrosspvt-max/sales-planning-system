import type { OnboardingReport, SkippedRow, WarningItem, ImportStatistics } from "../diagnostics";
import { CURRENT_REPORT_VERSION, obj, num, str, strArr } from "./schema";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Normalization guarantees SHAPE ONLY.
 *
 * Given a (already-migrated) document, it returns a complete {@link OnboardingReport} where
 * every field exists with the right primitive type: missing numbers → 0, missing arrays →
 * [], missing objects → {}, missing nullable strings → null. It performs NO cross-field
 * derivation or legacy recovery — that belongs to migration. Unknown extra fields are
 * dropped, so downstream consumers (and downloads) only ever see the current schema.
 */
export function normalizeReport(raw: unknown): OnboardingReport {
  const r = obj(raw);
  const summary = obj(r.summary);
  const packSizes = obj(summary.packSizes);
  const products = obj(summary.products);
  const dealers = obj(summary.dealers);
  const planningRows = obj(summary.planningRows);
  const stats = obj(r.statistics);
  const created = obj(r.createdMasters);
  const matched = obj(r.matchedMasters);

  const statistics: ImportStatistics = {
    rowsParsed: num(stats.rowsParsed),
    rowsImported: num(stats.rowsImported),
    rowsSkipped: num(stats.rowsSkipped),
    rowsMatched: num(stats.rowsMatched),
    rowsIgnored: num(stats.rowsIgnored),
    packCellsImported: num(stats.packCellsImported),
    packCellsSkipped: num(stats.packCellsSkipped),
  };

  const warnings: WarningItem[] = Array.isArray(r.warnings)
    ? r.warnings.map((w: unknown) => ({ type: str(obj(w).type, "Warning"), message: str(obj(w).message) }))
    : [];

  const skippedRows: SkippedRow[] = Array.isArray(r.skippedRows)
    ? r.skippedRows.map((s: unknown) => {
        const o = obj(s);
        return {
          worksheet: str(o.worksheet),
          dealer: str(o.dealer),
          product: str(o.product),
          pack: typeof o.pack === "string" ? o.pack : null,
          quantity: num(o.quantity),
          reason: str(o.reason, "Unspecified"),
        };
      })
    : [];

  return {
    version: CURRENT_REPORT_VERSION,
    workbookName: str(r.workbookName, "Onboarding"),
    summary: {
      packSizes: { total: num(packSizes.total), existing: num(packSizes.existing), created: num(packSizes.created) },
      products: { total: num(products.total), matched: num(products.matched), created: num(products.created) },
      dealers: { total: num(dealers.total), matched: num(dealers.matched), created: num(dealers.created) },
      planningRows: { parsed: num(planningRows.parsed), imported: num(planningRows.imported), skipped: num(planningRows.skipped) },
      monthlyRows: num(summary.monthlyRows),
      totalSeasonalQuantity: num(summary.totalSeasonalQuantity),
      totalMonthlyQuantity: num(summary.totalMonthlyQuantity),
    },
    createdMasters: {
      packSizes: strArr(created.packSizes),
      products: strArr(created.products),
      dealers: strArr(created.dealers),
      officer: typeof created.officer === "string" ? created.officer : null,
      season: typeof created.season === "string" ? created.season : null,
    },
    matchedMasters: { products: num(matched.products), dealers: num(matched.dealers), officers: num(matched.officers) },
    skippedRows,
    warnings,
    statistics,
    planId: typeof r.planId === "string" ? r.planId : null,
    seasonId: str(r.seasonId),
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
