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
  /** The dealer's CURRENT master-data status (Dealer.status: PENDING | ACTIVE | INACTIVE | DEFAULTER). */
  status: string;
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

import { dealerStatusLabel } from "./dealer-status";

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

export type ReportFilterKey = "party" | "status" | "state" | "territory" | "officer";
export const REPORT_FILTER_KEYS: readonly ReportFilterKey[] = ["party", "status", "state", "territory", "officer"];
export type ReportFilters = Partial<Record<ReportFilterKey, string[]>>;

/** The master-data part of a report row — what the column filters read. Filter values: dealer id, status, state, territory, officer id. */
export interface ReportFilterable {
  dealerId: string;
  party: string;
  status: string;
  state: string | null;
  territory: string | null;
  salesOfficer: string | null;
  salesOfficerId: string | null;
}
export type ReportFilterOptions = Record<ReportFilterKey, { value: string; label: string }[]>;

const filterValue = (row: ReportFilterable, key: ReportFilterKey): string =>
  key === "party" ? row.dealerId : key === "status" ? row.status : key === "state" ? (row.state ?? "") : key === "territory" ? (row.territory ?? "") : (row.salesOfficerId ?? "");

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
    status: collect("status", (r) => dealerStatusLabel(r.status)),
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

/* ------------------------------ cascading (dependent) filters ------------------------------ */

/**
 * Parent → child order used to resolve conflicts: State, then Territory, then Sales Officer, then Status, then Party. A selected value is
 * judged only against the selections EARLIER in this order, so changing a parent (e.g. State) clears the children that no
 * longer fit, while a child never knocks out its parent.
 */
export const CASCADE_ORDER: readonly ReportFilterKey[] = ["state", "territory", "officer", "status", "party"];

/**
 * Remove selected values that conflict with the (earlier) selections — e.g. State UP → MP clears Territory LUCKNOW. A value is
 * dropped only when it EXISTS in the caller's authorized rows yet no row matches it together with the earlier selections.
 * A value unknown to the authorized rows is deliberately KEPT (it matches nothing → an empty result), so a manipulated
 * parameter can neither widen the result nor be silently turned into "no filter".
 */
export function pruneReportFilters(rows: readonly ReportFilterable[], filters: ReportFilters): ReportFilters {
  const kept: ReportFilters = {};
  for (const key of CASCADE_ORDER) {
    const selected = filters[key] ?? [];
    if (selected.length === 0) continue;
    const known = new Set(rows.map((row) => filterValue(row, key)));
    const compatible = new Set(applyReportFilters(rows, kept).map((row) => filterValue(row, key)));
    const values = selected.filter((value) => !known.has(value) || compatible.has(value));
    if (values.length > 0) kept[key] = values;
  }
  return kept;
}

/**
 * Option lists for the four dropdowns, each derived from the authorized rows that match every OTHER active filter (its own
 * column is not constrained, so more values can still be added — OR within a column). Nothing is hard-coded; with no active
 * filter this equals `reportFilterOptions(rows)`. Search text and Payment Aging do not shape the options.
 */
export function cascadedFilterOptions(rows: readonly ReportFilterable[], filters: ReportFilters): ReportFilterOptions {
  const out = {} as ReportFilterOptions;
  for (const key of REPORT_FILTER_KEYS) {
    const { [key]: _own, ...others } = filters; // eslint-disable-line @typescript-eslint/no-unused-vars
    out[key] = reportFilterOptions(applyReportFilters(rows, others))[key];
  }
  return out;
}

/**
 * "Apply Filters" step (pure; the page calls it). Choosing filters only changes `pending`; the table/export/URL use `applied`, which
 * moves ONLY here: when pending differs from applied and no apply is already running. A real change resets to page 1; with no pending
 * change (or while applying) nothing changes — so no needless refetch and no duplicate request.
 */
export function applyFilterStep(state: { pending: ReportFilters; applied: ReportFilters; page: number; applying: boolean }):
  { applied: ReportFilters; page: number; applying: boolean; changed: boolean } {
  if (state.applying || sameReportFilters(state.pending, state.applied)) return { applied: state.applied, page: state.page, applying: state.applying, changed: false };
  return { applied: state.pending, page: 1, applying: true, changed: true };
}

/** Same selections? (order-insensitive per column; an empty column equals a missing one) */
export function sameReportFilters(a: ReportFilters, b: ReportFilters): boolean {
  return REPORT_FILTER_KEYS.every((key) => {
    const x = [...(a[key] ?? [])].sort(), y = [...(b[key] ?? [])].sort();
    return x.length === y.length && x.every((value, i) => value === y[i]);
  });
}

/* ------------------------------ "Last Update" indicator ------------------------------ */

/**
 * "Last Update" = when the most recent Day Book was successfully uploaded. It is read from the EXISTING upload records
 * (nothing new is stored): the audit entry the monthly Day Book commit writes only AFTER it succeeds (it also covers an
 * identical re-upload), and the Last Payment import history (monthly + Historical Day Book). Failed uploads write neither.
 * The audit entry's identity is fixed here so the loader and the Day Book commit cannot drift apart (a test pins it).
 */
export const DAYBOOK_UPLOAD_AUDIT_ENTITY = "recoveryPlan";
export const DAYBOOK_UPLOAD_AUDIT_PREFIX = "Day Book upload for ";

/** "YYYY-MM-DD" → "DD/MM/YYYY" (no Date object → no timezone can shift the day). Null/invalid → null. */
export function formatLastUpdate(isoDate: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/* ------------------------------ Excel export (same columns, same order, same display values as the table) ------------------------------ */

export const NO_EXPORT_DATA_MESSAGE = "No data available to export for the selected filters.";

export const EXPORT_COLUMNS: readonly { key: string; label: string; format: "text" | "number" | "currency" }[] = [
  { key: "party", label: "Party", format: "text" },
  { key: "status", label: "Status", format: "text" },
  { key: "state", label: "State", format: "text" },
  { key: "territory", label: "Territory", format: "text" },
  { key: "salesOfficer", label: "Sales Officer", format: "text" },
  { key: "lastPaymentDate", label: "Last Payment Date", format: "text" },
  { key: "amount", label: "Amount", format: "currency" },
  { key: "days", label: "Days", format: "number" },
];

/** Report rows → export rows using the ALREADY-CALCULATED values (nothing is recomputed). Missing values are blank cells. */
export function toExportRows(rows: readonly LastPaymentReportRow[]): ({ id: string } & Record<string, string | number>)[] {
  return rows.map((r) => ({
    id: r.dealerId,
    party: r.party,
    status: dealerStatusLabel(r.status), // display label: Active / Pending / Defaulter …
    state: r.state ?? "",
    territory: r.territory ?? "",
    salesOfficer: r.salesOfficer ?? "",
    lastPaymentDate: formatLastUpdate(r.lastPaymentDate) ?? "", // DD/MM/YYYY, like the page
    amount: r.amount ?? "",
    days: r.days ?? "",
  }));
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
