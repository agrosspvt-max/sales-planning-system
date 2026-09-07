/**
 * PURE Scheme Upload decision logic (no DB, no `server-only`) — the one definition of the upload's
 * non-arithmetic rules, shared by the server and unit-tested directly:
 *   - date-range validation (required, Start ≤ End, cross-month allowed, inclusive),
 *   - per-scheme validity for the tracking range (no silent out-of-period; NONE excluded),
 *   - the enrolled-dealer + required-product contribution filter (only these become SchemeSale facts).
 * Achievement arithmetic itself lives in the Phase 4 engine (`scheme-achievement.ts`); this module never
 * duplicates it.
 */

export type SchemeRequirementTypeName = "NONE" | "PRODUCT_BASED" | "VALUE_BASED";

export interface DateRange { start: Date; end: Date }

export type RangeResult = { ok: true; range: DateRange } | { ok: false; error: string };

/** Validate a YYYY-MM-DD range. Inclusive; cross-month allowed; Start ≤ End. UTC-midnight Dates. */
export function validateRange(startStr: string | null | undefined, endStr: string | null | undefined): RangeResult {
  if (!startStr) return { ok: false, error: "Start Date is required" };
  if (!endStr) return { ok: false, error: "End Date is required" };
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Start Date is invalid" };
  if (Number.isNaN(end.getTime())) return { ok: false, error: "End Date is invalid" };
  if (start.getTime() > end.getTime()) return { ok: false, error: "Start Date must be on or before End Date" };
  return { ok: true, range: { start, end } };
}

export interface SchemeRangeMeta {
  requirementType: SchemeRequirementTypeName;
  isPerpetual: boolean;
  startDate: Date | null;
  endDate: Date | null;
}

const dayStart = (d: Date) => new Date(d.toISOString().slice(0, 10)).getTime();

/**
 * Why a scheme cannot receive this upload range, or null when valid. NONE schemes have no requirement.
 * Non-perpetual schemes require the tracking range to fall within the scheme's active period (no silent
 * processing outside a scheme's dates); perpetual schemes are always in period.
 */
export function schemeRangeInvalidReason(scheme: SchemeRangeMeta | undefined, range: DateRange): string | null {
  if (!scheme) return "Scheme not found or not permitted";
  if (scheme.requirementType === "NONE") return "Scheme has no achievement requirement (NONE)";
  if (scheme.isPerpetual) return null;
  if (scheme.startDate && range.start.getTime() < dayStart(scheme.startDate)) return "Upload start date is before the scheme's start date";
  if (scheme.endDate && range.end.getTime() > dayStart(scheme.endDate)) return "Upload end date is after the scheme's end date";
  return null;
}

export interface QtyValue { qty: number; value: number }

/**
 * Keep only the facts that contribute to THIS scheme: enrolled dealer AND required product, with a non-zero
 * qty or value. Applied independently per scheme, so the SAME uploaded fact can contribute to several
 * schemes (it is never globally consumed). Input is keyed `${dealerId}|${productId}`.
 */
export function filterIncoming(
  matched: Map<string, { dealerId: string; productId: string; qty: number; value: number }>,
  enrolled: Set<string>,
  required: Set<string>,
): Map<string, QtyValue> {
  const out = new Map<string, QtyValue>();
  for (const [key, f] of matched) {
    if (!enrolled.has(f.dealerId) || !required.has(f.productId)) continue;
    if (f.qty === 0 && f.value === 0) continue;
    out.set(key, { qty: f.qty, value: f.value });
  }
  return out;
}
