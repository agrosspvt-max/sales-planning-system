/**
 * Season period → months. Shared by the client (live preview + validation) and the
 * server (SeasonMonth generation), so the two can never disagree. Reuses the existing
 * SeasonMonth concept — the admin never types month names.
 */

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export const MAX_SEASON_MONTHS = 12;

/** { value: 1..12, label: "January".. } for month <select> options. */
export const MONTH_OPTIONS = MONTH_NAMES.map((label, i) => ({ value: String(i + 1), label }));

export interface SeasonPeriod {
  startMonth: number; // 1..12
  startYear: number;
  endMonth: number; // 1..12
  endYear: number;
}

export interface GeneratedMonth {
  name: string;
  year: number;
  order: number; // 1-based
}

export interface SeasonMonthsResult {
  ok: boolean;
  error?: string;
  months: GeneratedMonth[];
}

function absIndex(month: number, year: number): number {
  return year * 12 + (month - 1);
}

function validMonth(m: number): boolean {
  return Number.isInteger(m) && m >= 1 && m <= 12;
}

/**
 * Generate every month between Start (inclusive) and End (inclusive), spanning year
 * boundaries. Enforces: valid months, End ≥ Start, and 1..MAX months (which also
 * guarantees no duplicate month names, since 12 consecutive months never repeat).
 */
export function generateSeasonMonths(period: SeasonPeriod): SeasonMonthsResult {
  const { startMonth, startYear, endMonth, endYear } = period;

  if (!validMonth(startMonth) || !validMonth(endMonth)) {
    return { ok: false, error: "Please choose a valid start and end month.", months: [] };
  }
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) {
    return { ok: false, error: "Please choose a valid start and end year.", months: [] };
  }

  const start = absIndex(startMonth, startYear);
  const end = absIndex(endMonth, endYear);

  if (end < start) {
    return { ok: false, error: "End date must not be before the start date.", months: [] };
  }

  const count = end - start + 1;
  if (count < 1) {
    return { ok: false, error: "A season must have at least one month.", months: [] };
  }
  if (count > MAX_SEASON_MONTHS) {
    return {
      ok: false,
      error: `A season can span at most ${MAX_SEASON_MONTHS} months (selected ${count}).`,
      months: [],
    };
  }

  const months: GeneratedMonth[] = [];
  for (let i = start; i <= end; i++) {
    const monthIdx = ((i % 12) + 12) % 12;
    const year = Math.floor(i / 12);
    months.push({ name: MONTH_NAMES[monthIdx], year, order: i - start + 1 });
  }
  return { ok: true, months };
}

/** "Jun 2026 → Nov 2026" from a period; returns "" if the period is incomplete. */
export function formatPeriod(
  startMonth: number | null | undefined,
  startYear: number | null | undefined,
  endMonth: number | null | undefined,
  endYear: number | null | undefined,
): string {
  if (!startMonth || !startYear || !endMonth || !endYear) return "";
  if (!validMonth(startMonth) || !validMonth(endMonth)) return "";
  return `${MONTH_SHORT[startMonth - 1]} ${startYear} → ${MONTH_SHORT[endMonth - 1]} ${endYear}`;
}
