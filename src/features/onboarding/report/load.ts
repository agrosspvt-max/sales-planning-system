import type { OnboardingReport } from "../diagnostics";
import { detectVersion, runMigrations } from "./migrate";
import { normalizeReport } from "./normalize";
import { validateReport } from "./validate";

/**
 * The single entry point for reading a persisted Migration Report.
 *
 *   Persisted JSON → version detection → migration → normalization → validation → UI
 *
 * Consumers receive a {@link LoadedReport} whose `report` is ALWAYS a complete, current-
 * schema document. `ok` tells the UI whether to show the "Invalid Migration Report"
 * notice; even when `ok` is false the report is still renderable (empty/zero defaults),
 * so nothing downstream needs defensive optional chaining.
 */
export interface LoadedReport {
  /** Always a full, current-schema report — safe to read without guards. */
  report: OnboardingReport;
  /** False → validation failed or the document was unreadable; show the invalid notice. */
  ok: boolean;
  /** Human-readable problems (validation failures, future-version note, parse errors). */
  errors: string[];
  /** The version detected on the stored document (0 = unreadable/corrupted). */
  sourceVersion: number;
}

/** Run the full pipeline on an already-parsed value. Never throws. */
export function loadReport(raw: unknown): LoadedReport {
  try {
    const sourceVersion = detectVersion(raw);
    const { migrated, futureVersion } = runMigrations(raw, sourceVersion);
    const report = normalizeReport(migrated);
    const { valid, errors } = validateReport(report);

    const allErrors = [...errors];
    if (futureVersion) {
      allErrors.push(
        `Report version ${sourceVersion} is newer than supported (${report.version}); showing a best-effort view.`,
      );
    }
    if (allErrors.length) {
      console.warn("[MigrationReport] loaded with issues:", { sourceVersion, errors: allErrors });
    }
    // A future version is renderable (shape is valid post-normalize) so we keep ok=true;
    // only genuine validation failures flip ok=false.
    return { report, ok: valid, errors: allErrors, sourceVersion };
  } catch (e) {
    console.error("[MigrationReport] unreadable report:", e);
    return {
      report: normalizeReport({}),
      ok: false,
      errors: [`Unreadable report: ${(e as Error).message}`],
      sourceVersion: 0,
    };
  }
}

/**
 * Load from a raw stored string (e.g. `OnboardingRecord.report`).
 * Returns `null` only when there is genuinely no report (empty/null column). Corrupted
 * JSON yields an `ok:false` LoadedReport so the UI shows the invalid notice rather than
 * silently hiding the record.
 */
export function loadReportString(raw: string | null | undefined): LoadedReport | null {
  if (raw == null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[MigrationReport] corrupted JSON — could not parse stored report.");
    return {
      report: normalizeReport({}),
      ok: false,
      errors: ["Corrupted JSON — the stored report could not be parsed."],
      sourceVersion: 0,
    };
  }
  return loadReport(parsed);
}
