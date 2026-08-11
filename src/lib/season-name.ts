/**
 * Canonical season-name handling. Season names are case-insensitive throughout the app:
 * "Kharif", "KHARIF", "kharif" and "KhArIf" all refer to the same season. Every write path
 * (manual create/edit, seasonal-plan create, onboarding import, API) canonicalises the name
 * before validation/matching, and the display form is always Title Case (e.g. " KHARIF " → "Kharif").
 *
 * This is the single source of truth for that rule — do not re-implement casing logic elsewhere.
 */

/**
 * Case-insensitive matching / uniqueness key: trimmed, inner whitespace collapsed, lowercased.
 * Two names share a season iff they have the same key AND the same year.
 *   "  KHARIF  " → "kharif"   |   "Rabi  Extra" → "rabi extra"
 */
export function seasonNameKey(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Canonical DISPLAY form: trimmed, inner whitespace collapsed, Title Case.
 *   "KHARIF" → "Kharif"   |   "khArIf" → "Kharif"   |   " rabi  extra " → "Rabi Extra"
 * The year is a separate field and is intentionally left untouched here.
 */
export function canonicalSeasonName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}
