/**
 * Migration Report — schema version + low-level coercion helpers.
 *
 * A persisted Migration Report is a versioned JSON document. `CURRENT_REPORT_VERSION` is
 * the shape the rest of the app expects; the loader (see ./load) migrates any older
 * document up to it. Bumping the schema means: (1) raise this constant, and (2) add one
 * migrator to the registry in ./migrate — no UI changes required.
 */
export const CURRENT_REPORT_VERSION = 2;

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Any value → a plain object (never null/array). */
export function obj(v: unknown): Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

/** Any value → a finite number, else `fallback`. */
export function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Any value → a string, else `fallback`. */
export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Any value → an array of strings (non-strings dropped). */
export function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/** First finite number among the candidates, else `undefined` (lets normalization default it). */
export function firstNum(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
