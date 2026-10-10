/**
 * Daily Work Template — PURE helpers (no DB, no React), so the same rules run on the server service and in
 * unit tests. Two concerns:
 *   1. Resolve the CURRENT RUNNING MONTH (which SeasonMonth "September" is) from the real calendar date.
 *   2. Derive per-dealer Pending and the COMBINED SUMMARY row from the dealer rows (never stored).
 *
 * Business rules (from the spec — not invented here):
 *   SALES    Pending = current-month Monthly Sales Plan − current-month Actual Sales.
 *   RECOVERY Pending = Total Recovery Plan − Actual Total Recovery.
 * The combined row is ALWAYS derived from the selected dealer rows; non-aggregatable fields (Type) collapse
 * to the shared value, or "MIXED" when they differ.
 */

import { MONTH_NAMES } from "./season-months";

export type DailyWorkSection = "SALES" | "RECOVERY" | "APPOINTMENT" | "SCHEME_CONVERSION";
export type DailyWorkType = "REGULAR" | "SCHEME";
/** Optional Recovery-row metadata; never an actual receipt or financial instruction. */
export const RECOVERY_PAYMENT_MODES = ["CHEQUE", "UPI", "NEFT_RTGS", "CASH"] as const;
export type RecoveryPaymentMode = typeof RECOVERY_PAYMENT_MODES[number];

/**
 * Payment Mode (Daily REPORT only) says how an ACTUAL recovery was received, so it exists only while Today's Recovery is a
 * positive amount. `actual` is the numeric value from state (never a formatted string); blank / NaN / <= 0 → not applicable.
 */
export function paymentModeApplies(actual: number | string | null | undefined): boolean {
  const n = typeof actual === "string" ? (actual.trim() === "" ? NaN : Number(actual)) : actual;
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}
/** The Payment Mode to keep for a recovery amount: the choice while the amount is positive, otherwise none (cleared). */
export function paymentModeForActual(actual: number | string | null | undefined, mode: RecoveryPaymentMode | null): RecoveryPaymentMode | null {
  return paymentModeApplies(actual) ? mode : null;
}
/** Post-submit appointment result. */
export type AppointmentStatus = "APPOINTED" | "NOT_APPOINTED";
/** Post-submit scheme-conversion achievability (was today's planned conversion achieved?). */
export type Achievability = "YES" | "NO";

/** Daily Work's authoritative business timezone. The application operates on India calendar dates. */
export const DAILY_WORK_TIME_ZONE = "Asia/Kolkata";

/**
 * Current Daily Work business date as YYYY-MM-DD. `Intl` applies the named timezone before extracting the
 * calendar fields, avoiding the previous UTC `toISOString()` day shift around India midnight.
 */
export function currentBusinessDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DAILY_WORK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value;
  const year = part("year"), month = part("month"), day = part("day");
  if (!year || !month || !day) throw new Error("Unable to resolve the Daily Work business date");
  return `${year}-${month}-${day}`;
}

/** The clock the submission-deadline rules read. Production never replaces it; tests set `now` to pin the moment. */
export const dailyWorkClock: { now: () => Date } = { now: () => new Date() };

/** The calendar date `days` after/before a YYYY-MM-DD business date (pure calendar arithmetic, no timezone involved). */
export function addBusinessDays(workDate: string, days: number): string {
  const d = new Date(`${workDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** The previous CALENDAR day. Daily Work has no holiday/working-day model, so every calendar day is sequential. */
export const previousBusinessDate = (workDate: string): string => addBusinessDays(workDate, -1);

/** UTC instant of a wall-clock time in the Daily Work business timezone (offset resolved by `Intl`, never the browser/server zone). */
function businessWallTimeToUtc(date: string, hour: number, minute: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, hour, minute);
  const offsetAt = (instant: number): number => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: DAILY_WORK_TIME_ZONE, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(instant));
    const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(instant / 1000) * 1000;
  };
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}

/** The Daily Report for `workDate` may be submitted until 12:00:00 noon (business timezone) of the FOLLOWING calendar day. */
export function dailyReportDeadline(workDate: string): Date {
  return businessWallTimeToUtc(addBusinessDays(workDate, 1), 12, 0);
}
/** Noon itself is still allowed; any later instant is past the deadline. */
export const isReportDeadlinePassed = (workDate: string, now: Date): boolean => now.getTime() > dailyReportDeadline(workDate).getTime();

/**
 * Server-derived state of the PREVIOUS day's Daily Report (nothing is stored for it — it follows from existing data + the clock):
 *  NOT_APPLICABLE – the previous day had no submitted Daily Plan, so there is no report to wait for or to miss
 *  SUBMITTED      – the previous report was submitted (its day is FINALIZED); never becomes Missed
 *  PENDING        – plan submitted, report not submitted, and the noon deadline has NOT passed → submit it first (blocks today's plan)
 *  MISSED         – plan submitted, report never submitted and the deadline HAS passed → no longer submittable; today's plan is allowed
 */
export type PreviousReportState = "NOT_APPLICABLE" | "SUBMITTED" | "PENDING" | "MISSED";
export function previousReportState(prev: { planned: boolean; finalized: boolean }, previousDate: string, now: Date): PreviousReportState {
  if (prev.finalized) return "SUBMITTED";
  if (!prev.planned) return "NOT_APPLICABLE";
  return isReportDeadlinePassed(previousDate, now) ? "MISSED" : "PENDING";
}
/** Only a report that can STILL be submitted blocks the next plan; a Missed one never does. */
export const previousReportBlocksPlan = (state: PreviousReportState): boolean => state === "PENDING";

/** A Daily Plan day that was never finalized once its deadline passed — a derived display state, never a stored submission. */
export const isReportMissed = (workDate: string, planSubmitted: boolean, finalized: boolean, now: Date): boolean =>
  planSubmitted && !finalized && isReportDeadlinePassed(workDate, now);

/**
 * The date a Daily Report read/write targets. The Daily Work page works on TODAY, except that yesterday's report stays actionable until
 * its noon deadline. Anything other than today / yesterday falls back to today (the service still enforces the deadline).
 */
export function resolveReportDate(requested: unknown, now: Date = dailyWorkClock.now()): string {
  const today = currentBusinessDate(now);
  return typeof requested === "string" && requested === previousBusinessDate(today) ? requested : today;
}

/** The current calendar month name ("September"), matching how SeasonMonth.name is stored. */
export function currentMonthName(now: Date = new Date()): string {
  return MONTH_NAMES[now.getMonth()];
}

/**
 * The month NAME for a Daily Work date string "YYYY-MM-DD" (parsed as a plain date, no timezone), matching
 * how SeasonMonth.name is stored. 2026-09-21 → "September", 2026-10-01 → "October". The month is ALWAYS
 * derived from the Daily Work date, never the server's current date.
 */
export function monthNameForDate(workDate: string): string | null {
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(workDate);
  if (!m) return null;
  const monthIndex = Number(m[1]) - 1; // 0..11
  return MONTH_NAMES[monthIndex] ?? null;
}

/**
 * Pick the SeasonMonth that matches a given month NAME (e.g. "September"). Returns null when the season does
 * not include that month — the caller then shows a zero/empty monthly plan rather than a season total.
 */
export function resolveSeasonMonthByName<T extends { id: string; name: string }>(months: T[], monthName: string | null): T | null {
  if (!monthName) return null;
  return months.find((m) => m.name === monthName) ?? null;
}

/**
 * Pick the SeasonMonth for the current running month (by the server's date). Kept for callers that mean
 * "today"; Daily Work uses `resolveSeasonMonthByName(months, monthNameForDate(workDate))` so the month
 * follows the Daily Work date, not the server clock.
 */
export function resolveCurrentSeasonMonth<T extends { id: string; name: string }>(
  months: T[],
  now: Date = new Date(),
): T | null {
  return resolveSeasonMonthByName(months, currentMonthName(now));
}

/** Round to 2 decimals (paise) to avoid floating drift when summing Decimal-sourced numbers. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** SALES pending for one dealer: current-month plan − current-month actual sales (never below data). */
export function salesPending(monthlyPlan: number, actualSales: number): number {
  return round2(monthlyPlan - actualSales);
}

/** RECOVERY pending for one dealer: Total Recovery Plan − Actual Total Recovery. */
export function recoveryPending(totalRecoveryPlan: number, actualTotalRecovery: number): number {
  return round2(totalRecoveryPlan - actualTotalRecovery);
}

/** A dealer row as it feeds the combined summary (works for both Sales and Recovery). */
export interface DailyWorkDealerRow {
  monthlyPlan: number; // Monthly Sales Plan / Monthly Recovery Plan
  actual: number; // current-month Actual Sales / Actual Total Recovery (the value used for Pending)
  pending: number;
  todaysPlan: number;
  todaysActual: number; // Today's Sales / Today's Recovery
  type: DailyWorkType | null; // Sales Type / Recovery Type (null before chosen)
}

export interface DailyWorkCombined {
  dealerCount: number;
  dealerLabel: string; // "1 Dealer" / "2 Dealers"
  monthlyPlan: number;
  actual: number; // Σ current-month actual sales / actual recovery
  pending: number;
  todaysPlan: number;
  todaysActual: number;
  /** Shared type when all rows agree, else "MIXED"; null when there are no rows. */
  type: DailyWorkType | "MIXED" | null;
}

export interface DailyWorkCountLabels {
  dealer: string;
  dealers: string;
  market: string;
  markets: string;
}

const DEFAULT_COUNT_LABELS: DailyWorkCountLabels = { dealer: "Dealer", dealers: "Dealers", market: "Market", markets: "Markets" };

/** "1 Dealer" / "N Dealers" (0 → "0 Dealers"), with optional configured count nouns. */
export function dealerCountLabel(count: number, labels: Pick<DailyWorkCountLabels, "dealer" | "dealers"> = DEFAULT_COUNT_LABELS): string {
  return `${count} ${count === 1 ? labels.dealer : labels.dealers}`;
}

/**
 * The COMBINED SUMMARY row — always derived from the dealer rows, so it can never drift from them.
 * Amounts sum; Type collapses to the shared value or "MIXED".
 */
export function combineDailyWorkRows(rows: DailyWorkDealerRow[], labels?: Pick<DailyWorkCountLabels, "dealer" | "dealers">): DailyWorkCombined {
  const dealerCount = rows.length;
  const sum = (pick: (r: DailyWorkDealerRow) => number) => round2(rows.reduce((s, r) => s + pick(r), 0));

  let type: DailyWorkType | "MIXED" | null = null;
  const types = rows.map((r) => r.type).filter((t): t is DailyWorkType => t != null);
  if (types.length > 0) type = types.every((t) => t === types[0]) ? types[0] : "MIXED";

  return {
    dealerCount,
    dealerLabel: dealerCountLabel(dealerCount, labels),
    monthlyPlan: sum((r) => r.monthlyPlan),
    actual: sum((r) => r.actual),
    pending: sum((r) => r.pending),
    todaysPlan: sum((r) => r.todaysPlan),
    todaysActual: sum((r) => r.todaysActual),
    type,
  };
}

/* =====================================================================================
 * SECTION 3 — DEALER APPOINTMENT (combined-row derivation only; plan/pending are placeholders)
 * ===================================================================================== */

/** "N Markets" across the selected rows (count of UNIQUE non-empty market names), with configured nouns. */
export function marketCountLabel(count: number, labels: Pick<DailyWorkCountLabels, "market" | "markets"> = DEFAULT_COUNT_LABELS): string {
  return `${count} ${count === 1 ? labels.market : labels.markets}`;
}

export interface AppointmentRow {
  marketName: string;
  status: AppointmentStatus | null; // post-submit; null before
}
export interface AppointmentCombined {
  dealerCount: number;
  dealerLabel: string; // "2 Dealers"
  marketCount: number; // unique non-empty markets
  marketLabel: string; // "2 Markets"
  /** Shared status when all rows agree, else "MULTIPLE"; null (→ "—") when no row has a status yet. */
  status: AppointmentStatus | "MULTIPLE" | null;
}

/** Combined Dealer Appointment row — dealer count + UNIQUE market count + collapsed status. */
export function combineAppointmentRows(rows: AppointmentRow[], labels?: DailyWorkCountLabels): AppointmentCombined {
  const dealerCount = rows.length;
  const markets = new Set(rows.map((r) => r.marketName.trim()).filter((m) => m.length > 0));
  const statuses = rows.map((r) => r.status).filter((s): s is AppointmentStatus => s != null);
  let status: AppointmentStatus | "MULTIPLE" | null = null;
  if (statuses.length > 0) status = statuses.every((s) => s === statuses[0]) ? statuses[0] : "MULTIPLE";
  return {
    dealerCount,
    dealerLabel: dealerCountLabel(dealerCount, labels),
    marketCount: markets.size,
    marketLabel: marketCountLabel(markets.size, labels),
    status,
  };
}

/* =====================================================================================
 * SECTION 4 — SCHEME CONVERSION (combined-row derivation; units, not rupees)
 * ===================================================================================== */

/** Conversion pending (UNITS): planned scheme units − already-converted units, floored at 0. */
export function conversionPending(plannedUnits: number, convertedUnits: number): number {
  return Math.max(0, Math.round(plannedUnits - convertedUnits));
}

export interface ConversionRow {
  schemeId: string | null; // the selected planned scheme
  plannedUnits: number;
  pending: number;
  todaysPlan: number;
  achievability: Achievability | null; // post-submit Yes/No; null before
}
export interface ConversionCombined {
  dealerCount: number;
  dealerLabel: string; // "2 Dealers"
  /** Shared scheme id when all rows agree, else "MULTIPLE"; null when no rows. */
  scheme: string | "MULTIPLE" | null;
  plannedUnits: number; // Σ planned units
  pending: number; // Σ pending units
  todaysPlan: number; // Σ today's planned units
  /** Yes/No collapsed: all YES → YES, all NO → NO, mixed → MULTIPLE, none entered → null (→ "—"). Never numeric. */
  achievability: Achievability | "MULTIPLE" | null;
}

/** Combined Scheme Conversion row — unit sums; scheme + achievability collapse (never summed numerically). */
export function combineConversionRows(rows: ConversionRow[], labels?: Pick<DailyWorkCountLabels, "dealer" | "dealers">): ConversionCombined {
  const dealerCount = rows.length;
  const sumInt = (pick: (r: ConversionRow) => number) => Math.round(rows.reduce((s, r) => s + pick(r), 0));

  const schemeIds = rows.map((r) => r.schemeId).filter((s): s is string => s != null);
  let scheme: string | "MULTIPLE" | null = null;
  if (schemeIds.length > 0) scheme = schemeIds.every((s) => s === schemeIds[0]) ? schemeIds[0] : "MULTIPLE";

  const results = rows.map((r) => r.achievability).filter((a): a is Achievability => a != null);
  let achievability: Achievability | "MULTIPLE" | null = null;
  if (results.length > 0) achievability = results.every((a) => a === results[0]) ? results[0] : "MULTIPLE";

  return {
    dealerCount,
    dealerLabel: dealerCountLabel(dealerCount, labels),
    scheme,
    plannedUnits: sumInt((r) => r.plannedUnits),
    pending: sumInt((r) => r.pending),
    todaysPlan: sumInt((r) => r.todaysPlan),
    achievability,
  };
}

/* =====================================================================================
 * TASK TYPE (Daily Plan display) — "Auto Task" vs "Manual", derived from the authoritative
 * Auto Task source/contribution link, never from amounts, names, dates or UI state.
 * ===================================================================================== */

export type TaskType = "AUTO" | "CALENDAR" | "MANUAL";

/**
 * A Daily Plan row's Task Type. A row is an Auto Task iff it carries at least one materialized Auto Task
 * contribution (the existing CN → DailyWorkEntry link). A row created from a Calendar Daily Task (the
 * CalendarEntry → DailyWorkEntry link) is CALENDAR. A row with only manual data is Manual. Precedence for a mixed row:
 * AUTO (a CN follow-up, which must be confirmed) over CALENDAR over MANUAL.
 */
export function rowTaskType(hasAutoContribution: boolean, hasCalendarContribution = false): TaskType {
  return hasAutoContribution ? "AUTO" : hasCalendarContribution ? "CALENDAR" : "MANUAL";
}

/**
 * Task Type is a dealer-row attribute and has no meaningful aggregate representation.
 * The combined summary row therefore always returns null (rendered using the neutral label).
 */
export function combineTaskType(_types: readonly TaskType[]): null {
  return null;
}

/* =====================================================================================
 * DAILY PLAN / DAILY REPORT VIEW SEPARATION
 * ===================================================================================== */

export const DailyWorkView = { PLAN: "PLAN", REPORT: "REPORT" } as const;
export type DailyWorkView = (typeof DailyWorkView)[keyof typeof DailyWorkView];
export const DEFAULT_DAILY_WORK_VIEW: DailyWorkView = DailyWorkView.PLAN;

/** Result/actual controls belong exclusively to Daily Report. */
export function dailyWorkShowsResults(view: DailyWorkView): boolean {
  return view === DailyWorkView.REPORT;
}

/** Daily Report consumes only existing SUBMITTED rows; Daily Plan retains the existing editor rows. */
export function visibleDailyWorkRows<T>(
  rows: readonly T[],
  view: DailyWorkView,
  isSubmitted: (row: T) => boolean,
): T[] {
  return view === DailyWorkView.REPORT ? rows.filter(isSubmitted) : [...rows];
}

/* =====================================================================================
 * SECTION COMPLETION (progress bar + No Plan + submit gate) — PURE, authoritative logic.
 *
 * Three effective states per MANDATORY section: FILLED (real user data), NO_PLAN (explicit persisted
 * decision), REMAINING (neither). FILLED/REMAINING are always DERIVED from real section data; only NO_PLAN
 * is persisted. Invariant: data present ⇒ FILLED (NO_PLAN is ignored/cleared), so the two never coexist.
 * "Others" is OPTIONAL and never a mandatory section here.
 * ===================================================================================== */

export const SectionStatus = { FILLED: "FILLED", NO_PLAN: "NO_PLAN", REMAINING: "REMAINING" } as const;
export type SectionStatus = (typeof SectionStatus)[keyof typeof SectionStatus];

/**
 * TEMPORARY SWITCH — Scheme Conversion in Daily Work.
 * `false` hides the Scheme Conversion Plan Type and removes it from every Daily Work requirement (progress bar,
 * No Plan, Submit Daily Work gate, Daily Report completion). Nothing is deleted: the code, DB columns/rows and
 * services stay intact (read paths keep working for history). To RE-ENABLE, change this ONE value to `true`.
 */
export const SCHEME_CONVERSION_ENABLED = false;

/** Every Daily Work section the system knows about (including a temporarily disabled one). Order = tab order. */
export const ALL_DAILY_WORK_SECTIONS = ["SALES", "RECOVERY", "APPOINTMENT", "SCHEME_CONVERSION", "VISITS", "OTHERS"] as const;
export type MandatorySection = (typeof ALL_DAILY_WORK_SECTIONS)[number];

/** Whether a section is currently part of the active Daily Work workflow. Unknown values are not enabled. */
export function isDailyWorkSectionEnabled(section: string | null | undefined): section is MandatorySection {
  return (ALL_DAILY_WORK_SECTIONS as readonly string[]).includes(section ?? "") && (section !== "SCHEME_CONVERSION" || SCHEME_CONVERSION_ENABLED);
}
/** The requested section if it is enabled, else the first enabled one (SALES) — a safe, loop-free fallback for stale state. */
export function resolveDailyWorkSection(section: string | null | undefined): MandatorySection {
  return isDailyWorkSectionEnabled(section) ? section : "SALES";
}

/** The active Daily Work sections (tabs, progress bar, submit gate, report completion), in order. Others is always shown. */
export const MANDATORY_SECTIONS: readonly MandatorySection[] = ALL_DAILY_WORK_SECTIONS.filter((s) => isDailyWorkSectionEnabled(s));

/** Whether each mandatory section has REAL user-entered data (derived; never trust placeholders/defaults). */
export interface SectionDataPresence {
  SALES: boolean;
  RECOVERY: boolean;
  APPOINTMENT: boolean;
  SCHEME_CONVERSION: boolean;
  VISITS: boolean;
  OTHERS: boolean;
}

/**
 * Resolve one section's effective status. Data ALWAYS wins (FILLED), so a stale NO_PLAN can never coexist
 * with real data. Otherwise an explicit No-Plan marking is NO_PLAN; else REMAINING.
 */
export function sectionStatus(hasData: boolean, noPlan: boolean): SectionStatus {
  if (hasData) return SectionStatus.FILLED;
  if (noPlan) return SectionStatus.NO_PLAN;
  return SectionStatus.REMAINING;
}

/** Effective status of every mandatory section, from derived data presence + the persisted No-Plan set. */
export function computeSectionStatuses(data: SectionDataPresence, noPlanSet: ReadonlySet<string>): Record<MandatorySection, SectionStatus> {
  const out = {} as Record<MandatorySection, SectionStatus>;
  for (const s of MANDATORY_SECTIONS) out[s] = sectionStatus(data[s], noPlanSet.has(s));
  return out;
}

export interface SectionStatusCounts { filled: number; noPlan: number; remaining: number; total: number }

/** Counts for the progress bar / textual summary. */
export function sectionStatusCounts(statuses: Record<MandatorySection, SectionStatus>): SectionStatusCounts {
  let filled = 0, noPlan = 0, remaining = 0;
  for (const s of MANDATORY_SECTIONS) {
    const v = statuses[s];
    if (v === SectionStatus.FILLED) filled++;
    else if (v === SectionStatus.NO_PLAN) noPlan++;
    else remaining++;
  }
  return { filled, noPlan, remaining, total: MANDATORY_SECTIONS.length };
}

/** Submit is allowed only when NO mandatory section is still REMAINING (every one is FILLED or NO_PLAN). */
export function canSubmitDailyWork(statuses: Record<MandatorySection, SectionStatus>): boolean {
  return MANDATORY_SECTIONS.every((s) => statuses[s] !== SectionStatus.REMAINING);
}

/** Parse/serialize the persisted CSV No-Plan set (only mandatory names are kept). */
export function parseNoPlanSet(csv: string | null | undefined): Set<MandatorySection> {
  const set = new Set<MandatorySection>();
  if (!csv) return set;
  for (const raw of csv.split(",").map((s) => s.trim())) {
    if ((ALL_DAILY_WORK_SECTIONS as readonly string[]).includes(raw)) set.add(raw as MandatorySection); // keeps stored flags of a disabled section
  }
  return set;
}
export function serializeNoPlanSet(set: ReadonlySet<string>): string {
  return ALL_DAILY_WORK_SECTIONS.filter((s) => set.has(s)).join(",");
}

/**
 * Daily Plan rule for Sales and Recovery dealer rows: Today's Plan must be a real number strictly greater than 0.
 * Blank, 0, negative, NaN/Infinity, null and undefined are all invalid (never a truthiness check).
 */
export function isValidTodaysPlan(value: unknown): boolean {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0;
}

export interface PlanRowToCheck { section: "SALES" | "RECOVERY"; dealerId: string; dealerName: string; todaysPlan: unknown }
/** The rows that break the rule, in input order. Each row is its own (section, dealer) — the same dealer in both sections is checked twice. */
export const invalidPlanRows = (rows: PlanRowToCheck[]): PlanRowToCheck[] => rows.filter((row) => !isValidTodaysPlan(row.todaysPlan));
/** "Sales — NAME" lines under the configurable heading (`{rows}` placeholder is replaced by the list). */
export function planRequiredMessage(template: string, rows: PlanRowToCheck[], sectionLabels: Record<"SALES" | "RECOVERY", string>): string {
  const list = rows.map((row) => `- ${sectionLabels[row.section]} — ${row.dealerName}`).join("\n");
  return template.replace("{rows}", list);
}

/* =====================================================================================
 * PERFORMANCE — section Planned / Actual totals (Company Performance summary)
 *
 * Units are fixed by the data each section stores, and Planned and Actual always use the SAME unit:
 *   Sales, Recovery     → rupees        (DailyWorkEntry.todaysPlan / todaysActual)
 *   Scheme Conversion   → scheme UNITS  (planned = todaysPlan; the report records only Yes/No achievability, so Actual = the units of the rows reported YES)
 *   Appointment         → dealer appointments (planned = rows with a typed dealer name; actual = rows reported APPOINTED)
 *   Visits              → visit COUNT   (planned = dealerVisits + newPartyVisits; actual = actualDealerVisits + actualNewPartyVisits)
 * Others has no numeric plan/actual and is never totalled.
 *
 * Rows given here are the day's SUBMITTED plan rows (planSubmittedAt set — the same rule as "Submitted Plans"). Drafts are never passed in.
 * Planned counts every submitted row; Actual counts a row only once that day's REPORT is finalized, and only the values actually entered
 * (a missing actual adds nothing; an explicit 0 or a negative adjustment is summed as entered).
 * ===================================================================================== */
export interface PerformanceEntryRow {
  section: string;
  typedDealerName: string | null;
  todaysPlan: string | number | null;
  todaysActual: string | number | null;
  resultStatus: string | null;
  dealerVisits: number | null;
  newPartyVisits: number | null;
  actualDealerVisits: number | null;
  actualNewPartyVisits: number | null;
  reportFinalized: boolean;
  /** Record identity — present on rows loaded for the contribution drill-down; the totals ignore them. */
  id?: string;
  officerId?: string;
  workDate?: Date | string;
  dealerId?: string | null;
  schemeId?: string | null;
  marketName?: string | null;
  entryType?: string | null;
  batchId?: string | null;
}
export interface PerformanceSectionTotal { planned: number; actual: number }
export type PerformanceSectionKey = "sales" | "recovery" | "schemeConversion" | "appointment" | "visits";
export type PerformanceSectionTotals = Record<PerformanceSectionKey, PerformanceSectionTotal>;

/** The ten clickable summary metrics. */
export const PERFORMANCE_METRICS = [
  "sales_planned", "sales_actual", "recovery_planned", "recovery_actual", "scheme_conversion_planned", "scheme_conversion_actual",
  "appointment_planned", "appointment_actual", "visits_planned", "visits_actual",
] as const;
export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];
export const isPerformanceMetric = (v: unknown): v is PerformanceMetric => (PERFORMANCE_METRICS as readonly string[]).includes(v as string);
export type PerformanceUnit = "currency" | "units" | "count";
export const PERFORMANCE_METRIC_INFO: Record<PerformanceMetric, { key: PerformanceSectionKey; kind: "planned" | "actual"; section: string; unit: PerformanceUnit }> = {
  sales_planned: { key: "sales", kind: "planned", section: "SALES", unit: "currency" }, sales_actual: { key: "sales", kind: "actual", section: "SALES", unit: "currency" },
  recovery_planned: { key: "recovery", kind: "planned", section: "RECOVERY", unit: "currency" }, recovery_actual: { key: "recovery", kind: "actual", section: "RECOVERY", unit: "currency" },
  scheme_conversion_planned: { key: "schemeConversion", kind: "planned", section: "SCHEME_CONVERSION", unit: "units" }, scheme_conversion_actual: { key: "schemeConversion", kind: "actual", section: "SCHEME_CONVERSION", unit: "units" },
  appointment_planned: { key: "appointment", kind: "planned", section: "APPOINTMENT", unit: "count" }, appointment_actual: { key: "appointment", kind: "actual", section: "APPOINTMENT", unit: "count" },
  visits_planned: { key: "visits", kind: "planned", section: "SUMMARY", unit: "count" }, visits_actual: { key: "visits", kind: "actual", section: "SUMMARY", unit: "count" },
};

/**
 * What ONE submitted plan row contributes to ONE metric — the single definition behind both the summary totals and the drill-down rows, so the
 * two can never disagree. null = the row does not contribute (not that sort of row, or the value was never entered / the report is not finalized).
 */
export function performanceRowValue(r: PerformanceEntryRow, metric: PerformanceMetric): number | null {
  const info = PERFORMANCE_METRIC_INFO[metric];
  if (r.section !== info.section) return null;
  const n = (v: string | number | null): number | null => (v == null || v === "" ? null : Number(v));
  const actual = info.kind === "actual";
  if (actual && !r.reportFinalized) return null;
  if (info.key === "sales" || info.key === "recovery") return n(actual ? r.todaysActual : r.todaysPlan);
  if (info.key === "schemeConversion") return actual && r.resultStatus !== "YES" ? null : n(r.todaysPlan);
  if (info.key === "appointment") {
    if ((r.typedDealerName ?? "").trim() === "") return null; // an unnamed placeholder row is not a planned appointment
    return actual && r.resultStatus !== "APPOINTED" ? null : 1;
  }
  const a = actual ? r.actualDealerVisits : r.dealerVisits, b = actual ? r.actualNewPartyVisits : r.newPartyVisits;
  return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

export function performanceSectionTotals(rows: readonly PerformanceEntryRow[]): PerformanceSectionTotals {
  const out: PerformanceSectionTotals = {
    sales: { planned: 0, actual: 0 }, recovery: { planned: 0, actual: 0 }, schemeConversion: { planned: 0, actual: 0 },
    appointment: { planned: 0, actual: 0 }, visits: { planned: 0, actual: 0 },
  };
  for (const metric of PERFORMANCE_METRICS) {
    const info = PERFORMANCE_METRIC_INFO[metric];
    out[info.key][info.kind] = round2(rows.reduce((sum, r) => sum + (performanceRowValue(r, metric) ?? 0), 0));
  }
  return out;
}
