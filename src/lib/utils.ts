import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Round a numeric-ish value to the nearest WHOLE number. The single normalization point for every
 * user-facing quantity/amount so the app never shows decimals (standard half-up rounding). Underlying
 * stored/DB precision is untouched — only the displayed value is normalized.
 */
export function roundWhole(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  return Number.isFinite(n as number) ? Math.round(n as number) : 0;
}

/** Whole-number INR currency (no paise). e.g. 890496000 → "₹89,04,96,000". */
export function formatCurrency(value: number | string): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(roundWhole(value));
}

/** Whole-number quantity with Indian grouping. e.g. 12.5 → "13". */
export function formatQty(value: number | string): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(roundWhole(value));
}

export function formatPercent(fraction: number | string): string {
  const n = typeof fraction === "string" ? Number(fraction) : fraction;
  return `${Math.round(n * 100)}%`;
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Compact, date-only "DD Mon YY" (e.g. 02 Sep 26). Time is never shown. Shared formatter used across the
 * Scheme Planning tables so every date reads the same. Display-only — never mutates the stored value.
 */
export function formatDateShort(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
}

export function formatSchemeDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : text;
}

export function parseSchemeDate(value: string) {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${yearText}-${monthText}-${dayText}`;
}


/** Scheme bill/payment amounts retain paise in display; storage/calculations are untouched. */
export function formatSchemeCurrency(value: number | string): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value));
}
