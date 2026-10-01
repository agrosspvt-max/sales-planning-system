import { MONTH_NAMES, MAX_SEASON_MONTHS, type SeasonPeriod } from "./season-months";

export interface CalendarMonth {
  month: number;
  year: number;
}
export interface MonthIdentity {
  calendarMonth?: number | null;
  calendarYear?: number | null;
}
/** Stored order remains historical insertion order. Calendar identity governs chronological reads. */
export const SEASON_MONTH_ORDER = [
  { calendarYear: "asc" as const },
  { calendarMonth: "asc" as const },
  { order: "asc" as const },
];
export function calendarIndex(m: CalendarMonth): number {
  return m.year * 12 + m.month - 1;
}
export function validCalendar(m: CalendarMonth): boolean {
  return (
    Number.isInteger(m.month) &&
    m.month >= 1 &&
    m.month <= 12 &&
    Number.isInteger(m.year) &&
    m.year >= 2000 &&
    m.year <= 2100
  );
}
export function identity(m: MonthIdentity): CalendarMonth | null {
  const value = { month: m.calendarMonth ?? NaN, year: m.calendarYear ?? NaN };
  return validCalendar(value) ? value : null;
}
export function monthLabel(m: MonthIdentity & { name: string }): string {
  const cal = identity(m);
  return cal
    ? `${MONTH_NAMES[cal.month - 1]} ${cal.year}`
    : `${m.name} (calendar identity needs review)`;
}
/** Display/range ordinal only; never write it back over historical database orders. */
export function calendarRows<T extends MonthIdentity & { order: number }>(rows: T[]): T[] {
  return [...rows]
    .sort((a, b) => {
      const ac = identity(a),
        bc = identity(b);
      return ac && bc
        ? calendarIndex(ac) - calendarIndex(bc)
        : ac
          ? -1
          : bc
            ? 1
            : a.order - b.order;
    })
    .map((m, i) => ({ ...m, order: i + 1 }));
}
export function calendarPeriod(months: CalendarMonth[]): SeasonPeriod {
  const sorted = [...months].sort((a, b) => calendarIndex(a) - calendarIndex(b));
  if (!sorted.length) throw new Error("A season must have at least one month.");
  return {
    startMonth: sorted[0].month,
    startYear: sorted[0].year,
    endMonth: sorted[sorted.length - 1].month,
    endYear: sorted[sorted.length - 1].year,
  };
}
export function validateAddMonths(existing: MonthIdentity[], requested: CalendarMonth[]) {
  if (!existing.length) throw new Error("Season has no months; calendar identity needs review.");
  const current = existing.map(identity);
  if (current.some((m) => !m))
    throw new Error(
      "Existing SeasonMonths have ambiguous calendar identity. Review these records before adding months.",
    );
  if (!requested.length || requested.some((m) => !validCalendar(m)))
    throw new Error("Select valid calendar months and years (2000–2100).");
  const seen = new Set<number>();
  for (const m of current as CalendarMonth[]) {
    const key = calendarIndex(m);
    if (seen.has(key))
      throw new Error(
        "Existing SeasonMonths contain duplicate calendar identities; review required.",
      );
    seen.add(key);
  }
  for (const m of requested) {
    const key = calendarIndex(m);
    if (seen.has(key))
      throw new Error(
        `${MONTH_NAMES[m.month - 1]} ${m.year} is already selected or exists in this season.`,
      );
    seen.add(key);
  }
  const all = [...(current as CalendarMonth[]), ...requested].sort(
    (a, b) => calendarIndex(a) - calendarIndex(b),
  );
  const span = calendarIndex(all[all.length - 1]) - calendarIndex(all[0]) + 1;
  if (span > MAX_SEASON_MONTHS)
    throw new Error(`A season can span at most ${MAX_SEASON_MONTHS} calendar months.`);
  if (span !== all.length)
    throw new Error("Season months must form a continuous calendar range; add all missing months.");
  return {
    existingPeriod: calendarPeriod(current as CalendarMonth[]),
    newPeriod: calendarPeriod(all),
    additions: [...requested].sort((a, b) => calendarIndex(a) - calendarIndex(b)),
  };
}
/** Explicit identity first; unresolved legacy rows retain their historical Recovery fallback. */
export function recoveryCalendar(
  season: { startMonth: number | null; startYear: number | null },
  month: MonthIdentity & { order: number },
  cutoff: Date,
): { year: number; month0: number } {
  const cal = identity(month);
  if (cal) return { year: cal.year, month0: cal.month - 1 };
  if (season.startMonth != null && season.startYear != null) {
    const idx = season.startMonth - 1 + month.order - 1;
    return { year: season.startYear + Math.floor(idx / 12), month0: ((idx % 12) + 12) % 12 };
  }
  return { year: cutoff.getFullYear(), month0: cutoff.getMonth() };
}
export function resolveWorkDateMonth<T extends MonthIdentity & { name?: string }>(
  months: T[],
  date: string,
): T | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!match) return null;
  if (
    months.some(
      (m) =>
        !identity(m) && m.name?.toLowerCase() === MONTH_NAMES[Number(match[2]) - 1]?.toLowerCase(),
    )
  ) {
    throw new Error(
      "This SeasonMonth has unresolved calendar identity; review required before resolving Daily Work dates.",
    );
  }
  return (
    months.find(
      (m) => m.calendarYear === Number(match[1]) && m.calendarMonth === Number(match[2]),
    ) ?? null
  );
}
