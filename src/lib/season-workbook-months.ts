import { MONTH_NAMES } from "./season-months";
import { identity, type MonthIdentity } from "./season-calendar";

export interface WorkbookMonth {
  month: number | null;
  year: number | null;
  issue?: string;
}
/** Month labels may be merged across a QTY/amount block. Never infer a month from its ordinal. */
export function workbookMonthColumns(
  rows: (string | number | null)[][],
  headerIndex: number,
  qtyCols: number[],
): WorkbookMonth[] {
  return qtyCols.map((col) => {
    // Only the label vertically aligned with this QTY column is authoritative.
    // Searching neighboring cells could borrow the next block's label and shift quantities.
    const found: WorkbookMonth[] = [];
    for (let r = 0; r <= headerIndex; r++) {
      const text = String(rows[r]?.[col] ?? "");
      const matches = MONTH_NAMES.map((name, i) => ({ name, month: i + 1 })).filter(({ name }) =>
        new RegExp(`\\b(?:${name}|${name.slice(0, 3)})\\b`, "i").test(text),
      );
      if (!matches.length) continue;
      const years = [...new Set(text.match(/\b(?:20\d{2}|2100)\b/g) ?? [])];
      if (matches.length !== 1 || years.length > 1) {
        return {
          month: null,
          year: null,
          issue: `Ambiguous calendar label for workbook QTY column ${col + 1}: ${text}`,
        };
      }
      found.push({ month: matches[0].month, year: years.length ? Number(years[0]) : null });
    }
    const monthValues = [...new Set(found.map((m) => m.month))];
    const yearValues = [...new Set(found.map((m) => m.year).filter((year) => year !== null))];
    if (monthValues.length > 1 || yearValues.length > 1) {
      return {
        month: null,
        year: null,
        issue: `Conflicting calendar labels for workbook QTY column ${col + 1}.`,
      };
    }
    return { month: monthValues[0] ?? null, year: yearValues[0] ?? null };
  });
}
/** A yearless June label is safe only when exactly one explicit June identity exists in this Season. */
export function resolveWorkbookMonths<T extends MonthIdentity & { id: string }>(
  months: T[],
  columns: WorkbookMonth[],
): string[] {
  const used = new Set<string>();
  return columns.map((column) => {
    if (column.issue) throw new Error(column.issue);
    if (!column.month)
      throw new Error(
        "Complete Workbook QTY columns require calendar month labels; positional month mapping is not supported.",
      );
    const matches = months.filter((m) => {
      const cal = identity(m);
      return cal && cal.month === column.month && (column.year == null || cal.year === column.year);
    });
    if (matches.length !== 1)
      throw new Error(
        `Workbook month ${column.month}${column.year ? `/${column.year}` : " (year unspecified)"} cannot be unambiguously matched to this Season.`,
      );
    if (used.has(matches[0].id))
      throw new Error("Workbook contains duplicate calendar-month columns.");
    used.add(matches[0].id);
    return matches[0].id;
  });
}
