import { CURRENT_REPORT_VERSION, obj, firstNum } from "./schema";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Version detection + explicit, step-wise migrations.
 *
 * Migration is *only* about translating an older document's STRUCTURE into the newest
 * one — renames and value recovery across schema versions. It must not fill defaults for
 * absent fields (that is normalization's job). Keeping these concerns apart means each
 * migrator stays a small, auditable "vN → vN+1" transform.
 */

/** Read the stored schema version. Unversioned (legacy) documents are Version 1. */
export function detectVersion(raw: unknown): number {
  const v = obj(raw).version;
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

/**
 * Version 1 → Version 2.
 *
 * V1 predates the sectioned schema. It stored `created` / `matched` (now
 * `createdMasters` / `matchedMasters`), kept import counts as flat top-level fields
 * (`rowsImported`, `imported`, …) rather than a `statistics` block, had no
 * `summary.planningRows`, and used plain-string `warnings`.
 */
export function migrateV1ToV2(input: unknown): Record<string, any> {
  const r = obj(input);
  const summary = obj(r.summary);
  const planningRows = obj(summary.planningRows);
  const stats = obj(r.statistics);

  // Recover the statistics block from legacy flat fields where the block is absent.
  const rowsImported = firstNum(stats.rowsImported, r.rowsImported, planningRows.imported, r.imported);
  const rowsSkipped = firstNum(stats.rowsSkipped, r.rowsSkipped, planningRows.skipped, r.skipped);
  const statistics = {
    // A v1 document that recorded only imported/skipped counts never stored a parsed total;
    // by the importer's definition, parsed = imported + skipped. Recover it so the record
    // stays internally consistent (and doesn't trip validation) rather than defaulting to 0.
    rowsParsed:
      firstNum(stats.rowsParsed, r.rowsParsed, planningRows.parsed, r.planningRows) ??
      (rowsImported !== undefined || rowsSkipped !== undefined
        ? (rowsImported ?? 0) + (rowsSkipped ?? 0)
        : undefined),
    rowsImported,
    rowsSkipped,
    rowsMatched: firstNum(stats.rowsMatched, r.rowsMatched),
    rowsIgnored: firstNum(stats.rowsIgnored, r.rowsIgnored),
    packCellsImported: firstNum(stats.packCellsImported, r.packCellsImported),
    packCellsSkipped: firstNum(stats.packCellsSkipped, r.packCellsSkipped),
  };

  // Derive the planning-row rollup from the recovered statistics when it was missing.
  const rolledPlanning = {
    parsed: firstNum(planningRows.parsed, statistics.rowsParsed),
    imported: firstNum(planningRows.imported, statistics.rowsImported),
    skipped: firstNum(planningRows.skipped, statistics.rowsSkipped),
  };

  // V1 warnings were plain strings; V2 uses { type, message }.
  const warnings = Array.isArray(r.warnings)
    ? r.warnings.map((w: unknown) => (typeof w === "string" ? { type: "Warning", message: w } : w))
    : r.warnings;

  return {
    ...r,
    version: 2,
    createdMasters: r.createdMasters ?? r.created,
    matchedMasters: r.matchedMasters ?? r.matched,
    summary: { ...summary, planningRows: rolledPlanning },
    statistics,
    warnings,
  };
}

/** Registry: version N → migrator producing version N+1. */
const MIGRATIONS: Record<number, (r: unknown) => Record<string, any>> = {
  1: migrateV1ToV2,
};

export interface MigrationOutcome {
  migrated: Record<string, any>;
  /** Version reached after migrating (== CURRENT unless a step was missing). */
  reachedVersion: number;
  /** True when the source declared a version newer than we support. */
  futureVersion: boolean;
}

/**
 * Apply migrations from `fromVersion` up to {@link CURRENT_REPORT_VERSION}.
 * A future version (newer than we support) is passed through untouched — we can't migrate
 * forward, so normalization renders a best-effort view from whatever known fields exist.
 */
export function runMigrations(raw: unknown, fromVersion: number): MigrationOutcome {
  if (fromVersion > CURRENT_REPORT_VERSION) {
    return { migrated: obj(raw), reachedVersion: fromVersion, futureVersion: true };
  }
  let current: Record<string, any> = obj(raw);
  let v = fromVersion;
  while (v < CURRENT_REPORT_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) break; // no path defined — normalization still guarantees a valid shape
    current = step(current);
    v += 1;
  }
  return { migrated: current, reachedVersion: v, futureVersion: false };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
