import { addBusinessDays } from "@/lib/daily-work";

/** Longest Performance date range the report accepts (also enforced by the server). */
export const PERFORMANCE_MAX_RANGE_DAYS = 92;
export const RANGE_PRESET_DAYS = [7, 15, 30] as const;
export type RangePresetDays = (typeof RANGE_PRESET_DAYS)[number];

/** "Last N Days" includes today: N calendar days ending on `today` (a YYYY-MM-DD business date — callers pass the Asia/Kolkata date). */
export function presetRange(days: number, today: string): { from: string; to: string } {
  return { from: addBusinessDays(today, -(days - 1)), to: today };
}

/** Which preset an applied range is exactly equal to, or null (then the range is a Custom Range). */
export function matchPreset(from: string, to: string, today: string): RangePresetDays | null {
  return RANGE_PRESET_DAYS.find((d) => { const r = presetRange(d, today); return r.from === from && r.to === to; }) ?? null;
}

export const inclusiveDays = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** Why a custom range cannot be applied, or null when it can. */
export function rangeProblem(from: string, to: string): "required" | "order" | "too_large" | null {
  if (!from || !to) return "required";
  if (from > to) return "order";
  if (inclusiveDays(from, to) > PERFORMANCE_MAX_RANGE_DAYS) return "too_large";
  return null;
}
