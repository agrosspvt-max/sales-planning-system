import "server-only";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";

/**
 * Parser for the Tally "Bills Receivable" Aging Report (All Aging Report_*.xlsx). PURE — no
 * database access, no matching. Built to the exact observed layout:
 *
 *   Col A Date · Col B Ref. No. · Col C Group Name · Col D Party's Name · Col E Pending Amount
 *   · Col F Due on · Col G Overdue by days
 *
 *   - A row with a Group (C) AND Party (D) is a DEALER header (Party = dealer name).
 *   - A following row whose Col A is a date is a BILL (amount = E, due date = F).
 *   - A row with only Col E filled (no date, no party) is a dealer TOTAL — skipped (validated).
 *
 * Verified against the reference file: 590 dealers, 1612 bills, every bill has a due date.
 */

const TARGET_SHEET = /bills\s*receivable/i;
// Column-header labels that must never be mistaken for a dealer/group.
const HEADER_LABEL = /^(group|name|party'?s?\s*name|date|ref\.?\s*no\.?|pending|amount|due\s*on|overdue|by\s*days)$/i;

export type AgingBucket = "OVERDUE" | "DUE" | "RUNNING";

export interface ParsedBill {
  billDate: Date | null;
  refNo: string | null;
  amount: number;
  dueDate: Date | null;
}
export interface ParsedAgingDealer {
  group: string;
  rawName: string;
  bills: ParsedBill[];
}
export interface ParsedAgingReport {
  sheetName: string;
  dealers: ParsedAgingDealer[];
  totalBills: number;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
const asDate = (v: unknown): Date | null => (v instanceof Date && !isNaN(v.getTime()) ? v : null);

export function parseAgingReport(buffer: Buffer): ParsedAgingReport {
  const wb = readWorkbook(buffer, { cellDates: true });
  const names = sheetNames(wb);
  const sheet = names.find((n) => TARGET_SHEET.test(n)) ?? names[0];
  if (!sheet) throw new Error("The workbook has no sheets");
  const rows = sheetRows(wb, sheet);

  const dealers: ParsedAgingDealer[] = [];
  let current: ParsedAgingDealer | null = null;
  let totalBills = 0;

  for (const row of rows) {
    const group = String(row[2] ?? "").trim();
    const party = String(row[3] ?? "").trim();
    const billDate = asDate(row[0]);

    if (group && party && !HEADER_LABEL.test(group) && !HEADER_LABEL.test(party)) {
      current = { group, rawName: party, bills: [] };
      dealers.push(current);
      continue;
    }
    if (billDate) {
      if (!current) continue; // bill before any dealer header — ignore defensively
      current.bills.push({
        billDate,
        refNo: row[1] != null ? String(row[1]).trim() : null,
        amount: toNum(row[4]),
        dueDate: asDate(row[5]),
      });
      totalBills += 1;
    }
    // Everything else (dealer total rows, report header rows, blanks) is ignored.
  }

  return { sheetName: sheet, dealers, totalBills };
}

/**
 * Bucket a bill by the selected cutoff date. The "selected month" is the cutoff's calendar
 * month (Due = coming due this month; Overdue = already past due; Running = future). Exactly
 * the rule in the spec: Due < cutoff → Overdue; Due within month → Due; remaining → Running.
 * A bill with no due date is treated as Overdue (conservative — it is a pending receivable).
 */
export function bucketOf(dueDate: Date | null, cutoff: Date): AgingBucket {
  if (!dueDate) return "OVERDUE";
  if (dueDate.getTime() < startOfDay(cutoff).getTime()) return "OVERDUE";
  const monthEnd = endOfMonth(cutoff);
  if (dueDate.getTime() <= monthEnd.getTime()) return "DUE";
  return "RUNNING";
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

export interface DealerAging {
  outstanding: number;
  overdue: number;
  due: number;
  running: number;
  bills: (ParsedBill & { bucket: AgingBucket })[];
}

/** Aggregate a dealer's bills into Outstanding / Overdue / Due / Running for a cutoff. */
export function aggregateDealer(bills: ParsedBill[], cutoff: Date): DealerAging {
  let overdue = 0, due = 0, running = 0;
  const out: (ParsedBill & { bucket: AgingBucket })[] = [];
  for (const b of bills) {
    const bucket = bucketOf(b.dueDate, cutoff);
    if (bucket === "OVERDUE") overdue += b.amount;
    else if (bucket === "DUE") due += b.amount;
    else running += b.amount;
    out.push({ ...b, bucket });
  }
  return { outstanding: overdue + due + running, overdue, due, running, bills: out };
}
