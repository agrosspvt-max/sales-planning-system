/**
 * Open-Month lifecycle (Section 42) — shared, framework-independent definitions used by both
 * server and client. The business rule "which month is editable" lives here (and in the
 * server module that enforces it), never scattered as ad-hoc `if (monthOpen)` checks.
 */
export type MonthStatus = "LOCKED" | "OPEN" | "CLOSED";

export const MONTH_STATUS_LABELS: Record<MonthStatus, string> = {
  LOCKED: "Locked",
  OPEN: "Open",
  CLOSED: "Closed",
};

/** The single predicate for month editability. Only an OPEN month accepts plan/actual entry. */
export function isMonthEditable(status: MonthStatus): boolean {
  return status === "OPEN";
}

/** Allowed management transitions (extensible: multiple opens, reopen, close after actuals). */
export const MONTH_TRANSITIONS: Record<MonthStatus, MonthStatus[]> = {
  LOCKED: ["OPEN"],
  OPEN: ["CLOSED"],
  CLOSED: ["OPEN"], // reopen a previous month for corrections
};
