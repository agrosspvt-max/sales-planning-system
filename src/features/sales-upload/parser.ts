import "server-only";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";
import { tightKey } from "@/lib/match-key";

/**
 * Parser for the Tally "Sales Register" export (Product.xlsx). PURE — no database access, no
 * matching. It only reads the exact workbook layout observed in the reference file:
 *
 *   Col A (Group Name) · Col B (Particulars) · Col C (Qty) · Col D (Value)
 *   - Rows 0–2 are headers.
 *   - A row with a dealer total (blank Qty in Col C) is a DEALER header (dealer name in Col B;
 *     its Col A group may be blank for later dealers in the same Tally group).
 *   - A row with an empty Col A and a non-empty Col B is a PRODUCT row for the current dealer.
 *
 * Product names carry pack info (e.g. "CHIMA 10X500GM") which is stripped to the base name.
 * Quantities carry units ("5 Kg") which are reduced to a number. Amount is taken verbatim.
 * Duplicate products under one dealer are merged (qty and amount summed).
 */

const TARGET_SHEET = /sales\s*register/i;
const HEADER_PARTICULARS = /^particulars$/i;
const HEADER_GROUP = /^group\s*name$/i;
const TOTAL_LABEL = /^total\b/i;

function hasCellValue(value: string | number | null | undefined): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

// Pack-size / unit tokens to strip from a Tally product name.
const UNIT = "(?:GMS?|KGS?|MLS?|LTRS?|LT|L|G)";
const RE_PAREN = /\([^)]*\)/g;
const RE_SIZE_FIRST = new RegExp(`\\d+\\s*${UNIT}\\s*[xX]\\s*\\d+`, "gi"); // 250GMX40
const RE_NXM = new RegExp(`\\d+\\s*[xX]\\s*\\d+(?:\\.\\d+)?\\s*${UNIT}?`, "gi"); // 10X500GM, 100 X 25ML, 6X5KG
const RE_TRAILING_SIZE = new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*${UNIT}\\b`, "gi"); // 25KG, 500ML, 1LTR
const RE_TRAILING_UNIT = /\s+(?:GMS?|KGS?|MLS?|LTRS?|LT)\s*$/gi; // bare trailing unit (e.g. "DIVIDER ML")

/** Strip pack-size / unit information from a Tally product name, keeping only the product. */
export function cleanProductName(raw: string): string {
  let s = String(raw)
    .replace(RE_PAREN, " ")
    .replace(RE_SIZE_FIRST, " ")
    .replace(RE_NXM, " ")
    .replace(RE_TRAILING_SIZE, " ")
    .replace(RE_TRAILING_UNIT, " ");
  s = s.replace(/\s+/g, " ").trim().replace(/[\s,\-]+$/, "").trim();
  return s;
}

/** Reduce a Tally quantity cell ("48.000 Kg", "10 LITRE", 5) to a number. */
export function cleanQuantity(v: string | number | null): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }
  return 0;
}

/** Amount comes straight from the workbook — never calculated. */
export function cleanAmount(v: string | number | null): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export interface ParsedSalesProduct {
  rawName: string;
  cleanName: string;
  key: string; // tightKey(cleanName) — merge key within a dealer
  qty: number;
  amount: number;
}
export interface ParsedSalesDealer {
  rawName: string;
  products: ParsedSalesProduct[];
}
export interface ParsedSalesWorkbook {
  sheetName: string;
  dealers: ParsedSalesDealer[];
  totalProductRows: number; // raw product rows read (before merge)
  mergedCount: number; // rows collapsed by duplicate-product merge
}

export function parseSalesWorkbook(buffer: Buffer): ParsedSalesWorkbook {
  const wb = readWorkbook(buffer);
  const names = sheetNames(wb);
  const sheet = names.find((n) => TARGET_SHEET.test(n)) ?? names[0];
  if (!sheet) throw new Error("The workbook has no sheets");
  const rows = sheetRows(wb, sheet);

  const dealers: ParsedSalesDealer[] = [];
  let current: ParsedSalesDealer | null = null;
  // Per-dealer merge index: tightKey(cleanName) → product (to sum duplicates).
  let byKey = new Map<string, ParsedSalesProduct>();
  let totalProductRows = 0;
  let mergedCount = 0;

  for (const row of rows) {
    const region = String(row[0] ?? "").trim();
    const particulars = String(row[1] ?? "").trim();

    // Skip the three header rows and any blank line.
    if (HEADER_GROUP.test(region) || HEADER_PARTICULARS.test(particulars)) continue;
    if (!region && !particulars) continue;
    if (TOTAL_LABEL.test(particulars)) continue;

    // Tally writes a Group Name only for the first dealer in some groups. Subsequent dealer
    // headers have an empty Group Name but the same structural marker: no product quantity in
    // Col C and a dealer total in Col D. Relying on Col A silently turned those dealers into
    // product rows under the preceding dealer, so they never reached the shared resolver.
    const isDealerHeader = !!particulars && (hasCellValue(region) || !hasCellValue(row[2] ?? null));
    if (isDealerHeader) {
      // Dealer header row — its Col C/D are the dealer's own totals, ignored.
      current = { rawName: particulars, products: [] };
      byKey = new Map();
      dealers.push(current);
      continue;
    }

    // Product row for the current dealer.
    if (!current) continue; // product row before any dealer header — ignore defensively
    const cleanName = cleanProductName(particulars);
    if (!cleanName) continue;
    totalProductRows += 1;
    const key = tightKey(cleanName);
    const qty = cleanQuantity(row[2] ?? null);
    const amount = cleanAmount(row[3] ?? null);

    const existing = byKey.get(key);
    if (existing) {
      existing.qty += qty;
      existing.amount += amount;
      mergedCount += 1; // this row merged into an earlier identical product
    } else {
      const p: ParsedSalesProduct = { rawName: particulars, cleanName, key, qty, amount };
      byKey.set(key, p);
      current.products.push(p);
    }
  }

  return { sheetName: sheet, dealers, totalProductRows, mergedCount };
}
