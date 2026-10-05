/**
 * Last Payment Report — PURE helpers (no DB, no React). The Last Payment value itself is NOT computed here: it comes
 * from the same selector Recovery Planning uses (see last-payment.server.ts). This file only derives the report's
 * "Days" column from it, orders rows, and parses the report's (deliberately tiny) query parameters.
 */

export type DaysSort = "days_asc" | "days_desc";
export const DEFAULT_DAYS_SORT: DaysSort = "days_desc"; // longest since last payment first
export const REPORT_DEFAULT_PAGE_SIZE = 50;

export interface LastPaymentReportRow {
  dealerId: string;
  party: string;
  state: string | null;
  territory: string | null;
  salesOfficer: string | null;
  /** "YYYY-MM-DD" of the receipt chosen by the existing Last Payment logic, else null. */
  lastPaymentDate: string | null;
  /** Credit amount of THAT same receipt, else null. */
  amount: number | null;
  /** Calendar days from lastPaymentDate to today; null when there is no payment (never invented). */
  days: number | null;
}

const DAY_MS = 86_400_000;
const utcMidnight = (isoDate: string) => Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`);

/** Whole calendar days from `from` to `to` (both "YYYY-MM-DD"); time of day and timezone play no part. */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);
}

/** TODAY − LAST PAYMENT DATE, or null when the dealer has no Last Payment. */
export function daysSincePayment(lastPaymentDate: string | null | undefined, today: string): number | null {
  return lastPaymentDate ? calendarDaysBetween(lastPaymentDate, today) : null;
}

/**
 * Order rows by Days, NUMERICALLY. Dealers without a payment (days = null) are kept together at the END for both
 * directions — never treated as 0 — and ties fall back to Party then dealer id so the order is stable.
 */
export function sortByDays<T extends { days: number | null; party: string; dealerId: string }>(rows: readonly T[], sort: DaysSort): T[] {
  const dir = sort === "days_asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.days === null || b.days === null) {
      if (a.days === b.days) return a.party.localeCompare(b.party) || a.dealerId.localeCompare(b.dealerId);
      return a.days === null ? 1 : -1;
    }
    return dir * (a.days - b.days) || a.party.localeCompare(b.party) || a.dealerId.localeCompare(b.dealerId);
  });
}

/** Case-insensitive Party-name search. */
export function matchesParty(party: string, search: string): boolean {
  const q = search.trim().toLocaleLowerCase();
  return !q || party.toLocaleLowerCase().includes(q);
}

/* ------------------------------ column filters (Party / State / Territory / Sales Officer) ------------------------------ */

export type ReportFilterKey = "party" | "state" | "territory" | "officer";
export const REPORT_FILTER_KEYS: readonly ReportFilterKey[] = ["party", "state", "territory", "officer"];
export type ReportFilters = Partial<Record<ReportFilterKey, string[]>>;

/** The master-data part of a report row — what the column filters read. Filter values: dealer id, state, territory, officer id. */
export interface ReportFilterable {
  dealerId: string;
  party: string;
  state: string | null;
  territory: string | null;
  salesOfficer: string | null;
  salesOfficerId: string | null;
}
export type ReportFilterOptions = Record<ReportFilterKey, { value: string; label: string }[]>;

const filterValue = (row: ReportFilterable, key: ReportFilterKey): string =>
  key === "party" ? row.dealerId : key === "state" ? (row.state ?? "") : key === "territory" ? (row.territory ?? "") : (row.salesOfficerId ?? "");

/** OR within a column, AND across columns. A row missing a column's value never matches an active filter on it. */
export function applyReportFilters<T extends ReportFilterable>(rows: readonly T[], filters: ReportFilters): T[] {
  const active = REPORT_FILTER_KEYS.filter((key) => (filters[key]?.length ?? 0) > 0);
  if (active.length === 0) return [...rows];
  return rows.filter((row) => active.every((key) => { const v = filterValue(row, key); return v !== "" && filters[key]!.includes(v); }));
}

/** Option lists for the four filter dropdowns — built only from the rows passed in (the caller's scoped dataset). */
export function reportFilterOptions(rows: readonly ReportFilterable[]): ReportFilterOptions {
  const collect = (key: ReportFilterKey, label: (row: ReportFilterable) => string | null) => {
    const seen = new Map<string, string>();
    for (const row of rows) {
      const value = filterValue(row, key), text = label(row);
      if (value && text && !seen.has(value)) seen.set(value, text);
    }
    return [...seen.entries()].map(([value, text]) => ({ value, label: text })).sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  };
  return {
    party: collect("party", (r) => r.party),
    state: collect("state", (r) => r.state),
    territory: collect("territory", (r) => r.territory),
    officer: collect("officer", (r) => r.salesOfficer),
  };
}

/* ------------------------------ Payment Aging filter (on the already-derived Days value) ------------------------------ */

export type PaymentAgingOperator = "lt" | "gt" | "eq" | "between";
export const PAYMENT_AGING_OPERATORS: readonly PaymentAgingOperator[] = ["lt", "gt", "eq", "between"];
export type PaymentAgingFilter =
  | { operator: "lt" | "gt" | "eq"; value: number }
  | { operator: "between"; from: number; to: number };

const MAX_AGING_DAYS = 100_000;
/** A whole, non-negative number of days from text. Empty / non-numeric / negative / fractional / absurd input → null. */
export function parseAgingDays(text: string | null | undefined): number | null {
  const t = (text ?? "").trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n <= MAX_AGING_DAYS ? n : null;
}

/** The raw text the filter form holds before Apply. */
export interface PaymentAgingDraft { operator: PaymentAgingOperator; value: string; from: string; to: string }

/** Validate the form text. Returns the filter, or the message to show next to the form. */
export function buildPaymentAging(draft: PaymentAgingDraft): { filter: PaymentAgingFilter } | { error: string } {
  if (draft.operator === "between") {
    const from = parseAgingDays(draft.from), to = parseAgingDays(draft.to);
    if (from === null || to === null) return { error: "Enter whole numbers (0 or more) for From and To." };
    if (from > to) return { error: "From must be less than or equal to To." };
    return { filter: { operator: "between", from, to } };
  }
  const value = parseAgingDays(draft.value);
  if (value === null) return { error: "Enter a whole number of days (0 or more)." };
  return { filter: { operator: draft.operator, value } };
}

/** NUMERIC comparison on Days. A dealer without a payment (days = null) never matches — it is not treated as 0. */
export function matchesPaymentAging(days: number | null, filter: PaymentAgingFilter | null | undefined): boolean {
  if (!filter) return true;
  if (days === null || !Number.isFinite(days)) return false;
  switch (filter.operator) {
    case "lt": return days < filter.value;
    case "gt": return days > filter.value;
    case "eq": return days === filter.value;
    case "between": return days >= filter.from && days <= filter.to;
  }
}

export function applyPaymentAging<T extends { days: number | null }>(rows: readonly T[], filter: PaymentAgingFilter | null | undefined): T[] {
  return filter ? rows.filter((row) => matchesPaymentAging(row.days, filter)) : [...rows];
}

/** Short text for the header indicator: "< 45", "> 45", "= 45", "30–60". */
export function paymentAgingLabel(filter: PaymentAgingFilter): string {
  return filter.operator === "between" ? `${filter.from}–${filter.to}` : `${{ lt: "<", gt: ">", eq: "=" }[filter.operator]} ${filter.value}`;
}

/** Write the filter as query parameters (nothing for null). Same names the server parses. */
export function paymentAgingToParams(filter: PaymentAgingFilter | null, query: URLSearchParams): void {
  if (!filter) return;
  query.set("paymentAgingOperator", filter.operator);
  if (filter.operator === "between") { query.set("paymentAgingFrom", String(filter.from)); query.set("paymentAgingTo", String(filter.to)); }
  else query.set("paymentAgingValue", String(filter.value));
}

/** Read it back. Missing or invalid parameters yield null (no filter) — the same validation as the form. */
export function parsePaymentAging(sp: URLSearchParams): PaymentAgingFilter | null {
  const operator = sp.get("paymentAgingOperator") as PaymentAgingOperator | null;
  if (!operator || !PAYMENT_AGING_OPERATORS.includes(operator)) return null;
  const built = buildPaymentAging({ operator, value: sp.get("paymentAgingValue") ?? "", from: sp.get("paymentAgingFrom") ?? "", to: sp.get("paymentAgingTo") ?? "" });
  return "filter" in built ? built.filter : null;
}

export interface LastPaymentReportParams {
  search: string;
  sort: DaysSort;
  page: number;
  pageSize: number;
  filters: ReportFilters;
  /** Payment Aging (Days) filter, or null. Applied after the scoped dealers' Days are derived; never widens scope. */
  paymentAging: PaymentAgingFilter | null;
}

/**
 * The ONLY inputs the report accepts. Anything else in the query string (officer ids, scope flags, …) is ignored, so
 * a user can never widen their scope through parameters — scope is applied server-side from the session.
 */
export function parseLastPaymentReportParams(sp: URLSearchParams): LastPaymentReportParams {
  const sort = sp.get("sort") === "days_asc" ? "days_asc" : DEFAULT_DAYS_SORT;
  const page = Math.max(1, Math.floor(Number(sp.get("page") ?? 1)) || 1);
  const rawSize = Math.floor(Number(sp.get("pageSize") ?? REPORT_DEFAULT_PAGE_SIZE)) || REPORT_DEFAULT_PAGE_SIZE;
  // Filters are repeated parameters (?state=CG&state=MP). They can only NARROW the caller's scoped rows.
  const filters: ReportFilters = {};
  for (const key of REPORT_FILTER_KEYS) {
    const values = [...new Set(sp.getAll(key).map((v) => v.trim()).filter(Boolean))].slice(0, 500);
    if (values.length) filters[key] = values;
  }
  return { search: (sp.get("search") ?? "").trim().slice(0, 100), sort, page, pageSize: Math.min(200, Math.max(1, rawSize)), filters, paymentAging: parsePaymentAging(sp) };
}
