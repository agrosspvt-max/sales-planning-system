import "server-only";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";

/**
 * Parser for the Tally "Day Book" export (Daybook July_26.xlsx). PURE — no database access, no
 * matching. Reuses the shared workbook helpers (never a second Excel reader).
 *
 * Observed layout (reference file): a few company/title header rows, then a header row whose cells
 * include "Date", "Particulars", "Vch Type" and "Credit Amount", then one row per voucher:
 *
 *   Date · Particulars (dealer name) · StateName · GroupName · Vch Type · Vch No. · Debit · Credit
 *
 * We only need Date, Particulars, Vch Type and Credit Amount — located BY HEADER LABEL (not fixed
 * column index) so minor column reordering does not break the import.
 */

export interface ParsedDaybookRow {
  date: Date | null;
  particulars: string; // raw dealer name from the Day Book
  vchType: string;
  creditAmount: number;
}
export interface ParsedDaybook {
  rows: ParsedDaybookRow[];
  totalRows: number;
}

const HEADER_LABELS = {
  date: /^date$/i,
  particulars: /^particulars$/i,
  vchType: /^vch\.?\s*type$/i,
  credit: /^credit\s*amount$/i,
};

function toNum(v: string | number | null): number {
  if (v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function toDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseDaybook(buffer: Buffer): ParsedDaybook {
  const wb = readWorkbook(buffer, { cellDates: true });
  const names = sheetNames(wb);
  // Prefer a sheet named like "Day Book"; otherwise the first sheet.
  const sheet = names.find((n) => /day\s*book/i.test(n)) ?? names[0];
  if (!sheet) return { rows: [], totalRows: 0 };
  const grid = sheetRows(wb, sheet);

  // Locate the header row (the first row that carries the Particulars + Vch Type + Credit labels).
  let headerIdx = -1;
  const col = { date: -1, particulars: -1, vchType: -1, credit: -1 };
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    const idx = { date: -1, particulars: -1, vchType: -1, credit: -1 };
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell == null) continue;
      const s = String(cell).trim();
      if (idx.date < 0 && HEADER_LABELS.date.test(s)) idx.date = c;
      if (idx.particulars < 0 && HEADER_LABELS.particulars.test(s)) idx.particulars = c;
      if (idx.vchType < 0 && HEADER_LABELS.vchType.test(s)) idx.vchType = c;
      if (idx.credit < 0 && HEADER_LABELS.credit.test(s)) idx.credit = c;
    }
    if (idx.particulars >= 0 && idx.vchType >= 0 && idx.credit >= 0) {
      headerIdx = i;
      Object.assign(col, idx);
      break;
    }
  }
  if (headerIdx < 0) return { rows: [], totalRows: 0 };

  const rows: ParsedDaybookRow[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    const particulars = col.particulars >= 0 ? String(row[col.particulars] ?? "").trim() : "";
    const vchType = col.vchType >= 0 ? String(row[col.vchType] ?? "").trim() : "";
    // A valid voucher row must have a dealer name and a voucher type.
    if (!particulars || !vchType) continue;
    rows.push({
      date: col.date >= 0 ? toDate(row[col.date]) : null,
      particulars,
      vchType,
      creditAmount: col.credit >= 0 ? toNum(row[col.credit]) : 0,
    });
  }
  return { rows, totalRows: rows.length };
}

/** Voucher classification (Part 4). SR/CR = Credit Note OR Sales Return (any suffix); Receipt = Live. */
export function isSrCrVoucher(vchType: string): boolean {
  const s = vchType.toUpperCase();
  return s.includes("CREDIT NOTE") || s.includes("SALES RETURN");
}
export function isReceiptVoucher(vchType: string): boolean {
  return vchType.trim().toUpperCase() === "RECEIPT";
}
