/**
 * Tally Sales Register parser: a row is a DEALER header only when Col A holds a Group Name. Every other row with a particulars value is a
 * PRODUCT row of the current dealer, whatever its Qty / Value hold — Tally leaves Qty blank on value-only lines and writes negative amounts.
 * Generated workbooks cover each row shape; the real exports (when present on this machine) are checked as verification expectations only.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { testLoader } from "@/features/dealer-tags/test-loader";
import type { ParsedSalesWorkbook } from "./parser";

const parser = testLoader({})("src/features/sales-upload/parser.ts") as typeof import("./parser");
type Cell = string | number | null;
const HEAD: Cell[][] = [[" Group Name", "Particulars", "1-Oct-26", "9-Oct-26"], ["", "", "Total", "Sales"], ["", "Qty", "Value", null]];
const book = (rows: Cell[][]): Buffer => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...HEAD, ...rows]), "Sales Register");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
};
const parse = (rows: Cell[][]) => parser.parseSalesWorkbook(book(rows));
const r2 = (n: number) => Math.round(n * 100) / 100;
const shape = (p: ParsedSalesWorkbook) => JSON.stringify(p.dealers.map((d) => [d.rawName, d.products.map((x) => [x.cleanName, x.qty, r2(x.amount)])]));

/* ---- the exact Ganesh Agro example (rows 114–117 of the real export, with the dealers around it) ---- */
{
  const p = parse([
    ["MAHASAMUND", "Previous Dealer", 10, 5000], ["", "RETTOL 10X1LTR", 10, 5000],
    ["DURG", "Ganesh Agro berla CG", 70, 42335.28],
    ["", "BLACK CAT 20X500ML", null, -1655.93],
    ["", "MAXX OPEN 20X500ML", 20, 38095.24],
    ["", "MAXX OPEN 40X250ML", null, -7876.19],
    ["SHAJAPUR", "Next Dealer", 5, 2500], ["", "VIPER 40X133.2 GM", 5, 2500],
  ]);
  assert.equal(shape(p), JSON.stringify([["Previous Dealer", [["RETTOL", 10, 5000]]], ["Ganesh Agro berla CG", [["BLACK CAT", 0, -1655.93], ["MAXX OPEN", 20, 30219.05]]], ["Next Dealer", [["VIPER", 5, 2500]]]]), "Ganesh keeps its products; neighbours are untouched");
  assert.equal(p.dealers.length, 3, "no product row became a dealer");
  assert.deepEqual([p.totalProductRows, p.mergedCount], [5, 1], "5 source product rows; the two MAXX OPEN variants merged into one");
  const g = p.dealers[1]!.products;
  assert.equal(g[0]!.key === g[1]!.key, false, "BLACK CAT stays separate from MAXX OPEN");
  assert.equal(g[1]!.rawName, "MAXX OPEN 20X500ML", "the first variant's raw name is kept");
}

/* ---- blank-quantity products at the start, in the middle, at the end, and alone ---- */
{
  const p = parse([
    ["A", "First Dealer", null, 100], ["", "BLANK FIRST 10X1LTR", null, -10], ["", "NORMAL ONE 10X1LTR", 5, 60], ["", "NORMAL TWO 10X1LTR", 5, 50],
    ["B", "Middle Dealer", 10, 100], ["", "NORMAL ONE 10X1LTR", 5, 60], ["", "BLANK MIDDLE 10X1LTR", null, -20], ["", "NORMAL TWO 10X1LTR", 5, 60],
    ["C", "Last Dealer", 10, 100], ["", "NORMAL ONE 10X1LTR", 5, 60], ["", "NORMAL TWO 10X1LTR", 5, 60], ["", "BLANK LAST 10X1LTR", null, -20],
    ["D", "Alone Dealer", null, -30], ["", "BLANK ONLY 10X1LTR", null, -30],
    ["E", "Dealer After Alone", 1, 10], ["", "NORMAL ONE 10X1LTR", 1, 10],
  ]);
  assert.equal(shape(p), JSON.stringify([
    ["First Dealer", [["BLANK FIRST", 0, -10], ["NORMAL ONE", 5, 60], ["NORMAL TWO", 5, 50]]],
    ["Middle Dealer", [["NORMAL ONE", 5, 60], ["BLANK MIDDLE", 0, -20], ["NORMAL TWO", 5, 60]]],
    ["Last Dealer", [["NORMAL ONE", 5, 60], ["NORMAL TWO", 5, 60], ["BLANK LAST", 0, -20]]],
    ["Alone Dealer", [["BLANK ONLY", 0, -30]]],
    ["Dealer After Alone", [["NORMAL ONE", 1, 10]]],
  ]), "blank-quantity rows stay with their own dealer in every position, and the next dealer starts cleanly");
}

/* ---- quantity and amount are parsed independently ---- */
{
  const p = parse([["G", "Dealer", null, 0], ["", "BLANK POSITIVE 10X1LTR", null, 250.5], ["", "BLANK NEGATIVE 10X1LTR", null, -250.5], ["", "ZERO POSITIVE 10X1LTR", 0, 75], ["", "ZERO NEGATIVE 10X1LTR", 0, -75], ["", "ZERO ZERO 10X1LTR", 0, 0], ["", "TEXT AMOUNT 10X1LTR", "", "-1,234.50"]]);
  const by = Object.fromEntries(p.dealers[0]!.products.map((x) => [x.cleanName, [x.qty, x.amount]]));
  assert.equal(JSON.stringify(by), JSON.stringify({ "BLANK POSITIVE": [0, 250.5], "BLANK NEGATIVE": [0, -250.5], "ZERO POSITIVE": [0, 75], "ZERO NEGATIVE": [0, -75], "ZERO ZERO": [0, 0], "TEXT AMOUNT": [0, -1234.5] }), "blank / zero quantity keeps any signed amount; no clamping, no abs()");
  assert.equal(p.dealers.length, 1);
}
{
  const p = parse([["G", "Dealer", null, 0], ["", "NEG QTY 10X1LTR", -5, -500], ["", "LITRE 10X1LTR", "20.00 LITRE", 38095.24], ["", "KGS TEST 10X1LTR", "48.000 Kg", 100], ["", "NEG UNIT 10X1LTR", "-5 Kg", -50], ["", "NOS 10X1LTR", "1,250 Nos", 1], ["", "POS AMOUNT NEG QTY 10X1LTR", -2, 200]]);
  const by = Object.fromEntries(p.dealers[0]!.products.map((x) => [x.cleanName, [x.qty, x.amount]]));
  assert.equal(JSON.stringify(by), JSON.stringify({ "NEG QTY": [-5, -500], LITRE: [20, 38095.24], "KGS TEST": [48, 100], "NEG UNIT": [-5, -50], NOS: [1250, 1], "POS AMOUNT NEG QTY": [-2, 200] }), "negative and unit-bearing quantity text; the amount is never derived from the quantity");
}

/* ---- dealer headers: blank quantity, repeated Group Name, consecutive dealers, a dealer with no products ---- */
{
  const p = parse([
    ["SHAJAPUR", "Header Blank Qty One", null, 75047], ["", "P ONE 10X1LTR", 21, 38997], ["", "P TWO 10X1LTR", 10, 36050],
    ["SHAJAPUR", "Header Blank Qty Two", null, 121305], ["", "P ONE 10X1LTR", 120, 121305],
    ["DHAMTARI", "Dealer Without Products", 5, 100],
    ["DHAMTARI", "Last Dealer", 1, 1], ["", "P ONE 10X1LTR", 1, 1],
  ]);
  assert.equal(shape(p), JSON.stringify([["Header Blank Qty One", [["P ONE", 21, 38997], ["P TWO", 10, 36050]]], ["Header Blank Qty Two", [["P ONE", 120, 121305]]], ["Dealer Without Products", []], ["Last Dealer", [["P ONE", 1, 1]]]]), "a header's blank quantity is irrelevant, and a repeated Group Name still starts a new dealer");
  assert.equal(p.totalProductRows, 4);
  // The dealer's own totals are never added to its products.
  assert.equal(p.dealers[0]!.products.reduce((s, x) => s + x.amount, 0), 75047);
}

/* ---- structural rows ---- */
{
  const p = parse([["", "Orphan product before any dealer", 1, 1], ["G", "Dealer", 1, 1], ["", "Total", 99, 99], ["", "P ONE 10X1LTR", 1, 1], ["", "   ", null, null]]);
  assert.equal(shape(p), JSON.stringify([["Dealer", [["P ONE", 1, 1]]]]), "heading rows, orphan products, totals and blanks are ignored");
}

/* ---- duplicate aggregation + variant separation (existing behaviour) ---- */
{
  const p = parse([["G", "Dealer", null, 0], ["", "MAXX OPEN 20X500ML", 20, 38095.24], ["", "MAXX OPEN 40X250ML", null, -7876.19], ["", "MAXX OPEN 100 X 25ML", 5, 100], ["", "MAXX TRICHO 12X1KG", null, -885.71]]);
  assert.equal(shape(p), JSON.stringify([["Dealer", [["MAXX OPEN", 25, 30319.05], ["MAXX TRICHO", 0, -885.71]]]]), "pack variants of one product add up; a different product is not merged");
  assert.deepEqual([p.totalProductRows, p.mergedCount], [4, 2]);
}

/* ---- the same product under two DIFFERENT dealers is never merged across dealers ---- */
{
  const p = parse([["A", "Dealer A", null, 0], ["", "SAME 10X1LTR", null, -5], ["B", "Dealer B", null, 0], ["", "SAME 10X1LTR", 3, 30]]);
  assert.equal(shape(p), JSON.stringify([["Dealer A", [["SAME", 0, -5]]], ["Dealer B", [["SAME", 3, 30]]]]));
}

/* ---- consumers use only the fields the parser has always exported ---- */
{
  const p = parse([["G", "Dealer", 1, 1], ["", "P ONE 10X1LTR", null, -1]]);
  assert.deepEqual(Object.keys(p).sort(), ["dealers", "mergedCount", "sheetName", "totalProductRows"]);
  assert.deepEqual(Object.keys(p.dealers[0]!).sort(), ["products", "rawName"]);
  assert.deepEqual(Object.keys(p.dealers[0]!.products[0]!).sort(), ["amount", "cleanName", "key", "qty", "rawName"]);
}

/* ---- the actual Tally exports, when available (verification expectations, never parsing rules) ---- */
const HOME = process.env.HOME ?? "";
const NEW_EXPORT = `${HOME}/Downloads/Sales 01-10 To 09-10-26.xlsx`;
const OLD_EXPORT = `${HOME}/Downloads/Cowork task Sales planning system BRD 2026-10-05/local_d0c99be8-7f8f-4581-9247-9d4ce0cf4900/uploads/Product.xlsx`;
if (existsSync(NEW_EXPORT)) {
  const p = parser.parseSalesWorkbook(readFileSync(NEW_EXPORT));
  const total = r2(p.dealers.reduce((s, d) => s + d.products.reduce((t, x) => t + x.amount, 0), 0));
  assert.deepEqual([p.dealers.length, p.totalProductRows, total], [82, 325, 5399185.71], "Sales 01-10 To 09-10-26.xlsx: 82 dealers, 325 source product rows, amount total 5,399,185.71");
  assert.equal(p.dealers.filter((d) => d.products.length === 0).length, 0);
  const g = p.dealers.find((d) => d.rawName === "Ganesh Agro berla CG")!;
  assert.equal(JSON.stringify(g.products.slice(0, 2).map((x) => [x.cleanName, x.qty, r2(x.amount)])), JSON.stringify([["BLACK CAT", 0, -1655.93], ["MAXX OPEN", 20, 30219.05]]));
  assert.equal(r2(g.products.reduce((s, x) => s + x.amount, 0)), 42335.28, "Ganesh's products add up to its dealer total in the workbook");
  console.log("  (checked against the real Sales 01-10 To 09-10-26.xlsx)");
}
if (existsSync(OLD_EXPORT)) {
  const p = parser.parseSalesWorkbook(readFileSync(OLD_EXPORT));
  assert.deepEqual([p.dealers.length, p.totalProductRows], [332, 2208], "Product.xlsx reference export parses exactly as before");
  console.log("  (checked against the older Product.xlsx reference export)");
}
console.log("sales-upload parser.test.ts — all assertions passed");
