import "server-only";
import * as XLSX from "xlsx";
import { readWorkbook, sheetNames } from "@/lib/import/workbook";
import { daybookColumns, daybookSheet, isReceiptVoucher } from "@/features/recovery/daybook-parser";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ROWS = 20_000;
export interface SourceReceipt {
  rowKey: string;
  sourceOrder: number;
  party: string;
  date: string | null;
  amount: string | null;
  voucherNumber: string | null;
  errors: string[];
}
function calendarDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 9999) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    : null;
}
/** Explicit date-only parsing, including Excel's 1900/1904 calendar; never locale Date(string). */
export function receiptDate(value: unknown, date1904 = false): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return calendarDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value, { date1904 });
    return parsed ? calendarDate(parsed.y, parsed.m, parsed.d) : null;
  }
  const text = String(value ?? "").trim();
  let parts = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (parts) return calendarDate(+parts[1], +parts[2], +parts[3]);
  parts = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (parts) return calendarDate(+parts[3], +parts[2], +parts[1]);
  parts = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2}|\d{4})$/);
  if (!parts) return null;
  const month =
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
      parts[2].slice(0, 3).toLowerCase(),
    ) + 1;
  return calendarDate(parts[3].length === 2 ? 2000 + +parts[3] : +parts[3], month, +parts[1]);
}
export function receiptAmount(value: unknown): string | null {
  const text = String(value ?? "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text) || !Number.isFinite(+text) || +text <= 0 || +text >= 1e12)
    return null;
  return (+text).toFixed(2);
}
/** Adapter retains provenance/validation omitted by the monthly parser; same reader/layout/classifier. */
export function parseHistoricalDaybook(buffer: Buffer) {
  if (buffer.length > MAX_FILE_BYTES) throw new Error("Day Book must be at most 25 MB.");
  const wb = readWorkbook(buffer),
    names = sheetNames(wb),
    sheet = daybookSheet(names);
  if (!sheet) throw new Error("The workbook has no sheets.");
  const ws = wb.Sheets[sheet];
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  if (range.e.r - range.s.r + 1 > MAX_ROWS || range.e.c > 255)
    throw new Error("Day Book is limited to 20,000 rows and 256 columns. Split larger files.");
  // Preserve physical row numbers and blanks for exact-file retry identity.
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    blankrows: true,
    defval: null,
  });
  let columns: ReturnType<typeof daybookColumns> | null = null;
  const rows: SourceReceipt[] = [];
  let totalRows = 0,
    ignoredRows = 0;
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (row.every((v) => v == null || String(v).trim() === "")) continue;
    const found = daybookColumns(row);
    if (found.particulars >= 0 && found.vchType >= 0 && found.credit >= 0) {
      columns = found;
      continue;
    }
    if (!columns) continue;
    totalRows++;
    const party = String(row[columns.particulars] ?? "").trim();
    if (
      !isReceiptVoucher(String(row[columns.vchType] ?? "")) ||
      /^(grand\s*total|sub\s*total|total)$/i.test(party)
    ) {
      ignoredRows++;
      continue;
    }
    const date =
      columns.date < 0 ? null : receiptDate(row[columns.date], !!wb.Workbook?.WBProps?.date1904);
    const amount = receiptAmount(row[columns.credit]);
    const errors = [
      ...(!party ? ["Dealer name is missing."] : []),
      ...(!date ? ["Valid receipt date is required (DD/MM/YYYY, ISO or an Excel date)."] : []),
      ...(!amount ? ["Credit amount must be positive, with at most two decimal places."] : []),
    ];
    rows.push({
      rowKey: JSON.stringify([sheet, i + range.s.r + 1]),
      sourceOrder: i + range.s.r + 1,
      party,
      date,
      amount,
      voucherNumber: columns.voucher < 0 ? null : String(row[columns.voucher] ?? "").trim() || null,
      errors,
    });
  }
  if (!columns)
    throw new Error("Expected Particulars, Vch Type and Credit Amount headers were not found.");
  if (!rows.length)
    throw new Error("No Receipt transactions were found in the selected Day Book sheet.");
  return { sheet, ignoredSheets: names.filter((n) => n !== sheet), rows, totalRows, ignoredRows };
}
