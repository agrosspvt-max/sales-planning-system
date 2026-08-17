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
