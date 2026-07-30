import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number | string): string {
  const n = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);
}

export function formatPercent(fraction: number | string): string {
  const n = typeof fraction === "string" ? Number(fraction) : fraction;
  return `${(n * 100).toFixed(2)}%`;
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
