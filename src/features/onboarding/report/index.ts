/**
 * Migration Report loading pipeline (public surface).
 *   Persisted JSON → detectVersion → runMigrations → normalizeReport → validateReport → UI
 */
export { CURRENT_REPORT_VERSION } from "./schema";
export { detectVersion, migrateV1ToV2, runMigrations } from "./migrate";
export { normalizeReport } from "./normalize";
export { validateReport, type ValidationResult } from "./validate";
export { loadReport, loadReportString, type LoadedReport } from "./load";
