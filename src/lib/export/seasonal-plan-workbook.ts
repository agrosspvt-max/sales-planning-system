import ExcelJS from "exceljs";
import { isQuantityMode, type PlanningMode } from "@/lib/calc";
import { SheetNameRegistry, sheetRangeRef, sheetRef } from "./sheet-names";

/**
 * Seasonal Plan Excel export — ONE officer's selected seasonal plan version as a connected, multi-sheet workbook laid out like the reference
 * "Seasonal Planning" workbook: PRICELIST, Product Plan, Dealer Summary, then one sheet per dealer (alphabetical by displayed name).
 *
 * Pure: it receives an in-memory model (built by the export service from one consistent database read) and generates every formula from it.
 * Dependency direction: dealer inputs + effective prices → dealer calculations → Product Plan and Dealer Summary (no circular references; summary
 * cells are always calculated). The formulas mirror the system's calculation engine (src/lib/calc.ts), not the reference workbook's shortcuts:
 *   - a line's amount / NBV are computed on the dealer sheet from THAT line's effective (saved) price; Product Plan sums those line results, so
 *     dealer lines and merged source products priced differently are never re-priced by one product price;
 *   - actual sales amounts are the uploaded sales values (data), never quantity × rate; negative values are kept;
 *   - AMOUNT mode never invents a quantity; NBV mode leaves the amount blank when NBV % is 0 (as the engine does);
 *   - Season-v-Month difference = target − monthly planned, Pending = target − actual (the engine's corrected metrics);
 *   - achievement = actual ÷ plan, 0 when the plan is 0.
 * Every formula cell carries its computed result, so figures show immediately when the file is opened; Excel recalculates on load as well.
 */

export type ExportDealerStatus = "COMPLETED" | "NO_PLAN" | "REMAINING";
export interface ExportMonth { key: string; label: string }
export interface ExportLineMonth { planQty: number; saleQty: number; saleAmount: number }
export interface ExportLine {
  rate: number;
  nbvPercent: number;
  /** PACK_SIZE: the stored pack quantities (by pack size id). */
  packs: Record<string, number>;
  /** TOTAL_QUANTITY / AMOUNT / NBV: the single value in the season's mode (the workspace's seeded value). */
  value: number;
  months: Record<string, ExportLineMonth>;
}
export interface ExportProduct { productId: string; name: string; technicalName: string | null; effectiveId: string; effectiveName: string; effectiveTechnicalName: string | null }
export interface ExportDealer { dealerId: string; name: string; status: ExportDealerStatus; noPlanReason: string | null; lines: Record<string, ExportLine> }
export interface ExportCatalogueRow { productId: string; name: string; technicalName: string | null; rate: number; nbvPercent: number }
export interface SeasonalExportModel {
  officerName: string;
  stateName: string | null;
  seasonLabel: string; // e.g. "Kharif 2026"
  planLabel: string; // e.g. "Version 2 · Approved"
  modeLabel: string;
  mode: PlanningMode;
  packs: { id: string; name: string }[];
  months: ExportMonth[];
  catalogue: ExportCatalogueRow[];
  catalogueSourceLabel: string;
  products: ExportProduct[];
  dealers: ExportDealer[];
}

export const RESERVED_SHEETS = ["PRICELIST", "Product Plan", "Dealer Summary"] as const;

/* ------------------------------------------------ styles (reference workbook colours) ------------------------------------------------ */
const solid = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const FILL = {
  header: solid("FFE7E6E6"), live: solid("FFFFC000"), month: solid("FF5B9BD5"), calc: solid("FFD9D9D9"), input: solid("FFFFF2CC"),
  summaryHead: solid("FFA5A5A5"), summaryTotal: solid("FFEDEDED"), white: solid("FFFFFFFF"), missing: solid("FFF2F2F2"),
};
const thin = { style: "thin" as const, color: { argb: "FF000000" } };
const BORDER: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };
const FMT = {
  money: '_ * #,##0_ ;_ * -#,##0_ ;_ * "-"??_ ;_ @_ ',
  qty: '#,##0;-#,##0;"-"',
  rate: "#,##0.00",
  pct: "0.00%",
  summaryPct: "0.0%",
};
const CENTER: Partial<ExcelJS.Alignment> = { horizontal: "center", vertical: "middle", wrapText: true };
const LEFT: Partial<ExcelJS.Alignment> = { horizontal: "left", vertical: "middle", wrapText: true };

const colLetter = (c: number): string => { let s = ""; for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const addr = (c: number, r: number, abs = false) => (abs ? `$${colLetter(c)}$${r}` : `${colLetter(c)}${r}`);
type Result = number | string;

/* ------------------------------------------------ column layout ------------------------------------------------ */
interface MonthCols { key: string; label: string; first: number; qty: number; amt: number; nbv: number; sale: number; saleAmt: number; aNbv: number; pend: number; diffAmt: number; last: number }
interface Layout {
  rate?: number; nbvPct?: number; packCols: number[]; qty: number; amt: number; nbv: number; aQty: number; aAmt: number; aNbv: number; mainLast: number;
  lQty: number; lAmt: number; lNbv: number; diff: number; pend: number; months: MonthCols[]; lastCol: number;
  /** Every numeric column (summed on the totals row, aggregated by Product Plan). */
  valueCols: number[];
}
function layoutFor(mode: PlanningMode, packCount: number, months: ExportMonth[], withPrice: boolean): Layout {
  let c = 4;
  const rate = withPrice ? c++ : undefined;
  const nbvPct = withPrice ? c++ : undefined;
  const packCols = mode === "PACK_SIZE" ? Array.from({ length: packCount }, () => c++) : [];
  const qty = c++, amt = c++, nbv = c++, aQty = c++, aAmt = c++, aNbv = c++;
  const mainLast = aNbv;
  c++; // gap (as in the reference)
  const lQty = c++, lAmt = c++, lNbv = c++, diff = c++, pend = c++;
  const monthCols: MonthCols[] = months.map((m) => {
    c++; // gap
    const first = c;
    const mc = { key: m.key, label: m.label, first, qty: c++, amt: c++, nbv: c++, sale: c++, saleAmt: c++, aNbv: c++, pend: c++, diffAmt: c++, last: 0 };
    mc.last = mc.diffAmt;
    return mc;
  });
  const lastCol = monthCols.at(-1)?.last ?? pend;
  const valueCols = [...packCols, qty, amt, nbv, aQty, aAmt, aNbv, lQty, lAmt, lNbv, diff, pend, ...monthCols.flatMap((m) => [m.qty, m.amt, m.nbv, m.sale, m.saleAmt, m.aNbv, m.pend, m.diffAmt])];
  return { rate, nbvPct, packCols, qty, amt, nbv, aQty, aAmt, aNbv, mainLast, lQty, lAmt, lNbv, diff, pend, months: monthCols, lastCol, valueCols };
}

const FIRST_ROW = 4; // data rows start here (rows 1–3: info, section titles, column headers — as the reference)

/* ------------------------------------------------ cell writing helpers ------------------------------------------------ */
function put(ws: ExcelJS.Worksheet, r: number, c: number, value: ExcelJS.CellValue, style: { fill?: ExcelJS.Fill; numFmt?: string; bold?: boolean; align?: Partial<ExcelJS.Alignment>; color?: string } = {}) {
  const cell = ws.getCell(r, c);
  cell.value = value;
  cell.border = BORDER;
  if (style.fill) cell.fill = style.fill;
  if (style.numFmt) cell.numFmt = style.numFmt;
  if (style.bold || style.color) cell.font = { ...(style.bold ? { bold: true } : {}), ...(style.color ? { color: { argb: style.color } } : {}) };
  cell.alignment = style.align ?? CENTER;
}
const formula = (f: string, result: Result): ExcelJS.CellFormulaValue => ({ formula: f, result: result as number });
const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function writeHeaderBlock(ws: ExcelJS.Worksheet, L: Layout, model: SeasonalExportModel, opts: { title: string; nameBand: string; info: string }) {
  // Row 1: who / what (officer, state, season, plan version) and the legend.
  ws.mergeCells(1, 1, 1, 3);
  put(ws, 1, 1, opts.info, { bold: true, align: LEFT, fill: FILL.white });
  ws.getRow(1).height = 30;
  ws.mergeCells(1, 4, 1, L.mainLast);
  put(ws, 1, 4, "Yellow cells = planning inputs (editable).  Grey cells = calculated.  White cells = recorded monthly plan / sales data.", { align: LEFT, color: "FF595959" });
  // Row 2: section titles.
  ws.mergeCells(2, 1, 2, 3);
  put(ws, 2, 1, opts.title, { bold: true, fill: FILL.white });
  ws.mergeCells(2, 4, 2, L.mainLast);
  put(ws, 2, 4, opts.nameBand, { bold: true, fill: FILL.header, align: LEFT });
  ws.mergeCells(2, L.lQty, 2, L.pend);
  put(ws, 2, L.lQty, "Live Monthly Plan", { bold: true, fill: FILL.live });
  for (const m of L.months) { ws.mergeCells(2, m.first, 2, m.last); put(ws, 2, m.first, m.label, { bold: true, fill: FILL.month }); }
  // Row 3: column headers.
  const h = (c: number, text: string) => put(ws, 3, c, text, { bold: true, fill: FILL.white });
  h(1, "S.NO."); h(2, "PRODUCT NAME"); h(3, "TECHNICAL NAME");
  if (L.rate) h(L.rate, "RATE (SAVED PLAN PRICE)");
  if (L.nbvPct) h(L.nbvPct, "NBV %");
  L.packCols.forEach((c, i) => h(c, model.packs[i]!.name));
  h(L.qty, "TOTAL QTY");
  h(L.amt, model.mode === "AMOUNT" ? "PLANNED AMOUNT" : "Total Amount");
  h(L.nbv, "PLAN NBV");
  h(L.aQty, "ACTUAL SALES QTY"); h(L.aAmt, "AMOUNT"); h(L.aNbv, "ACTUAL NBV");
  h(L.lQty, "LIVE MONTHLY PLAN QTY"); h(L.lAmt, "LIVE MONTH PLAN AMT."); h(L.lNbv, "LIVE MONTH NBV AMT."); h(L.diff, "SEASON v. MONTH PLAN DIFF."); h(L.pend, "PENDING QTY.");
  for (const m of L.months) { h(m.qty, "QTY"); h(m.amt, "AMOUNT"); h(m.nbv, "PLAN NBV"); h(m.sale, "SALE"); h(m.saleAmt, "AMOUNT"); h(m.aNbv, "ACTUAL NBV"); h(m.pend, "PENDING QTY"); h(m.diffAmt, "DIFFERENCE AMOUNT"); }
  ws.getRow(3).height = 60;
}

function setWidths(ws: ExcelJS.Worksheet, L: Layout) {
  const w = (c: number, width: number) => { ws.getColumn(c).width = width; };
  w(1, 8.4); w(2, 22); w(3, 34.7);
  if (L.rate) w(L.rate, 11); if (L.nbvPct) w(L.nbvPct, 8);
  L.packCols.forEach((c) => w(c, 9));
  w(L.qty, 10.5); w(L.amt, 15.3); w(L.nbv, 14); w(L.aQty, 12); w(L.aAmt, 13.6); w(L.aNbv, 13.1); w(L.mainLast + 1, 3);
  w(L.lQty, 10.6); w(L.lAmt, 12); w(L.lNbv, 11); w(L.diff, 11.6); w(L.pend, 10.6);
  for (const m of L.months) { w(m.first - 1, 3); w(m.qty, 9.6); w(m.amt, 12.6); w(m.nbv, 12.6); w(m.sale, 9.6); w(m.saleAmt, 12.6); w(m.aNbv, 12.6); w(m.pend, 10); w(m.diffAmt, 13); }
}

function writeTotals(ws: ExcelJS.Worksheet, L: Layout, totalRow: number, lastDataRow: number, totals: Map<number, number>) {
  ws.mergeCells(totalRow, 1, totalRow, 3);
  put(ws, totalRow, 1, "TOTAL", { bold: true, fill: FILL.summaryTotal });
  if (L.rate) put(ws, totalRow, L.rate, null, { fill: FILL.summaryTotal });
  if (L.nbvPct) put(ws, totalRow, L.nbvPct, null, { fill: FILL.summaryTotal });
  for (const c of L.valueCols) {
    const fmt = [L.amt, L.nbv, L.aAmt, L.aNbv, L.lAmt, L.lNbv, ...L.months.flatMap((m) => [m.amt, m.nbv, m.saleAmt, m.aNbv, m.diffAmt])].includes(c) ? FMT.money : FMT.qty;
    const value = lastDataRow >= FIRST_ROW ? formula(`SUM(${addr(c, FIRST_ROW)}:${addr(c, lastDataRow)})`, totals.get(c) ?? 0) : 0;
    put(ws, totalRow, c, value, { bold: true, fill: FILL.summaryTotal, numFmt: fmt });
  }
  // Achievement (actual ÷ plan; 0 when the plan is 0 — the engine's rule).
  const ach = totalRow + 2;
  ws.mergeCells(ach, 1, ach, 3);
  put(ws, ach, 1, "ACHIEVEMENT %", { bold: true, align: LEFT });
  const pct = (num: number, den: number) => (den === 0 ? 0 : num / den);
  put(ws, ach, L.aAmt, formula(`IF(${addr(L.amt, totalRow)}=0,0,${addr(L.aAmt, totalRow)}/${addr(L.amt, totalRow)})`, pct(totals.get(L.aAmt) ?? 0, totals.get(L.amt) ?? 0)), { bold: true, numFmt: FMT.pct });
  put(ws, ach, L.aNbv, formula(`IF(${addr(L.nbv, totalRow)}=0,0,${addr(L.aNbv, totalRow)}/${addr(L.nbv, totalRow)})`, pct(totals.get(L.aNbv) ?? 0, totals.get(L.nbv) ?? 0)), { bold: true, numFmt: FMT.pct });
}

/* ------------------------------------------------ the workbook ------------------------------------------------ */
export interface BuiltSeasonalWorkbook { workbook: ExcelJS.Workbook; sheetNames: { dealerId: string; sheet: string }[] }

export function buildSeasonalPlanWorkbook(model: SeasonalExportModel): BuiltSeasonalWorkbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sales Planning System";
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };
  const mode = model.mode;
  const qtyMode = isQuantityMode(mode);
  const state = (model.stateName ?? "").trim();
  const title = `${state ? `${state.toUpperCase()} ` : ""}SEASON PRODUCT PLAN - ${model.seasonLabel.toUpperCase()}`;
  const info = `Officer: ${model.officerName}  ·  State: ${state || "—"}  ·  Season: ${model.seasonLabel}  ·  Plan: ${model.planLabel}  ·  Planning mode: ${model.modeLabel}`;

  /* ---- stable sheet names (ids → names), reserved names first ---- */
  const registry = new SheetNameRegistry([...RESERVED_SHEETS]);
  const dealerSheets = model.dealers.map((d) => ({ dealer: d, sheet: registry.allocate(d.name, "Dealer") }));

  /* ---- PRICELIST: the state catalogue + the saved plan prices that differ from it ---- */
  const price = wb.addWorksheet("PRICELIST", { views: [{ state: "frozen", ySplit: 1 }] });
  ["SR.NO.", "PRODUCT NAME", "TECHNICAL", "RATE", "%OF NBV"].forEach((t, i) => put(price, 1, i + 1, t, { bold: true, fill: FILL.white }));
  const catalogueRow = new Map<string, number>(); // productId → PRICELIST row
  model.catalogue.forEach((p, i) => {
    const r = i + 2;
    catalogueRow.set(p.productId, r);
    put(price, r, 1, i + 1, { bold: true });
    put(price, r, 2, p.name, { bold: true, align: LEFT });
    put(price, r, 3, p.technicalName ?? "", { align: LEFT });
    put(price, r, 4, p.rate, { numFmt: FMT.rate });
    put(price, r, 5, p.nbvPercent, { numFmt: FMT.pct });
  });
  const catalogueById = new Map(model.catalogue.map((p) => [p.productId, p]));
  // Saved plan prices: a line whose frozen price is not exactly today's price-list entry references its own row here, so the workbook opens with
  // the figures of the saved plan (historical prices are never replaced by newer catalogue prices).
  const productById = new Map(model.products.map((p) => [p.productId, p]));
  const savedRow = new Map<string, number>(); // `${productId}|${rate}|${nbv}` → row
  const savedRows: { key: string; productId: string; rate: number; nbv: number; lines: number }[] = [];
  const priceRef = new Map<string, { rateRef: string; nbvRef: string }>(); // `${dealerId}|${productId}` → references
  for (const { dealer } of dealerSheets) {
    for (const [productId, line] of Object.entries(dealer.lines)) {
      const cat = catalogueById.get(productId);
      let refs: { rateRef: string; nbvRef: string };
      if (cat && cat.rate === line.rate && cat.nbvPercent === line.nbvPercent) {
        const r = catalogueRow.get(productId)!;
        refs = { rateRef: `PRICELIST!${addr(4, r, true)}`, nbvRef: `PRICELIST!${addr(5, r, true)}` };
      } else {
        const key = `${productId}|${line.rate}|${line.nbvPercent}`;
        let r = savedRow.get(key);
        if (r === undefined) { r = savedRows.length + 2; savedRow.set(key, r); savedRows.push({ key, productId, rate: line.rate, nbv: line.nbvPercent, lines: 0 }); }
        savedRows[r - 2]!.lines += 1;
        refs = { rateRef: `PRICELIST!${addr(10, r, true)}`, nbvRef: `PRICELIST!${addr(11, r, true)}` };
      }
      priceRef.set(`${dealer.dealerId}|${productId}`, refs);
    }
  }
  ["SR.NO.", "PRODUCT NAME", "TECHNICAL", "SAVED PLAN RATE", "SAVED PLAN NBV %", "PRICE LIST RATE", "PRICE LIST NBV %", "PLAN LINES USING IT"].forEach((t, i) => put(price, 1, i + 7, t, { bold: true, fill: FILL.header }));
  savedRows.forEach((s, i) => {
    const r = i + 2;
    const p = productById.get(s.productId);
    const cat = catalogueById.get(s.productId);
    put(price, r, 7, i + 1, { bold: true });
    put(price, r, 8, p?.name ?? s.productId, { bold: true, align: LEFT });
    put(price, r, 9, p?.technicalName ?? "", { align: LEFT });
    put(price, r, 10, s.rate, { numFmt: FMT.rate, fill: FILL.header });
    put(price, r, 11, s.nbv, { numFmt: FMT.pct, fill: FILL.header });
    put(price, r, 12, cat ? cat.rate : "Not in price list", { numFmt: FMT.rate });
    put(price, r, 13, cat ? cat.nbvPercent : "—", { numFmt: FMT.pct });
    put(price, r, 14, s.lines, { numFmt: FMT.qty });
  });
  const noteRow = Math.max(model.catalogue.length, savedRows.length) + 3;
  price.mergeCells(noteRow, 1, noteRow, 5);
  put(price, noteRow, 1, `Price list: ${model.catalogueSourceLabel}. NBV % is a fraction shown as a percentage (0.25 = 25%).`, { align: LEFT, color: "FF595959" });
  price.mergeCells(noteRow, 7, noteRow, 14);
  put(price, noteRow, 7, savedRows.length === 0
    ? "Saved plan prices: every plan line uses the price list above."
    : "Saved plan prices: prices frozen on this plan's lines when they were planned, where they differ from today's price list. Dealer sheets use the saved price, exactly as the system does.", { align: LEFT, color: "FF595959" });
  price.getRow(noteRow).height = 45;
  [7.1, 22, 50, 10.6, 9.4, 2, 7.1, 22, 30, 13, 12, 13, 12, 12].forEach((width, i) => { price.getColumn(i + 1).width = width; });

  /* ---- dealer sheets are generated in memory first (rows / values); summaries reference them ---- */
  const DL = layoutFor(mode, model.packs.length, model.months, true);
  const PL = layoutFor(mode, model.packs.length, model.months, false);
  const products = model.products;
  const rowOf = new Map(products.map((p, i) => [p.productId, FIRST_ROW + i])); // identical rows on every dealer sheet (3D sums rely on it)
  const lastDataRow = FIRST_ROW + products.length - 1;
  const totalRow = FIRST_ROW + products.length;
  interface DealerValues { cells: Map<string, number>; totals: Map<number, number> } // `${col}|${row}` → numeric value
  const dealerValues = new Map<string, DealerValues>();
  const valueKey = (c: number, r: number) => `${c}|${r}`;

  const pp = wb.addWorksheet("Product Plan", { views: [{ state: "frozen", xSplit: 3, ySplit: 3 }] });
  const ds = wb.addWorksheet("Dealer Summary", { views: [{ state: "frozen", ySplit: 5 }] });

  for (const { dealer, sheet } of dealerSheets) {
    const ws = wb.addWorksheet(sheet, { views: [{ state: "frozen", xSplit: 3, ySplit: 3 }] });
    const statusText = dealer.status === "NO_PLAN" ? `No Plan${dealer.noPlanReason ? ` — ${dealer.noPlanReason}` : ""}` : dealer.status === "COMPLETED" ? "Completed" : "Remaining (not yet planned)";
    writeHeaderBlock(ws, DL, model, { title, nameBand: `DEALER NAME ${dealer.name}   ·   Status: ${statusText}`, info });
    setWidths(ws, DL);
    const cells = new Map<string, number>();
    const totals = new Map<number, number>();
    const add = (c: number, r: number, v: number) => { cells.set(valueKey(c, r), v); totals.set(c, (totals.get(c) ?? 0) + v); };
    products.forEach((p, i) => {
      const r = FIRST_ROW + i;
      const line = dealer.lines[p.productId];
      const has = !!line;
      const inputFill = has ? FILL.input : FILL.missing;
      put(ws, r, 1, i + 1, { bold: true });
      put(ws, r, 2, p.name, { bold: true, align: LEFT });
      put(ws, r, 3, has ? p.technicalName ?? "" : `${p.technicalName ? `${p.technicalName} — ` : ""}not in this dealer's plan`, { align: LEFT, color: has ? undefined : "FF7F7F7F" });
      const rate = line?.rate ?? 0, nbvPct = line?.nbvPercent ?? 0;
      const refs = priceRef.get(`${dealer.dealerId}|${p.productId}`);
      const R = addr(DL.rate!, r), E = addr(DL.nbvPct!, r);
      put(ws, r, DL.rate!, refs ? formula(refs.rateRef, rate) : null, { fill: FILL.calc, numFmt: FMT.rate });
      put(ws, r, DL.nbvPct!, refs ? formula(refs.nbvRef, nbvPct) : null, { fill: FILL.calc, numFmt: FMT.pct });
      // Planned figures in the season's mode.
      let qty: number | null = null, amt: Result = 0, nbv = 0;
      if (mode === "PACK_SIZE") {
        DL.packCols.forEach((c, k) => { const q = line?.packs[model.packs[k]!.id]; put(ws, r, c, has && q ? q : null, { fill: inputFill, numFmt: FMT.qty }); add(c, r, q ?? 0); });
        qty = sumOf(model.packs.map((pk) => line?.packs[pk.id] ?? 0));
        const qtyValue = DL.packCols.length ? formula(`SUM(${addr(DL.packCols[0]!, r)}:${addr(DL.packCols.at(-1)!, r)})`, qty) : 0;
        put(ws, r, DL.qty, qtyValue, { fill: FILL.calc, bold: true, numFmt: FMT.qty });
      } else if (mode === "TOTAL_QUANTITY") {
        qty = line?.value ?? 0;
        put(ws, r, DL.qty, has && qty ? qty : null, { fill: inputFill, bold: true, numFmt: FMT.qty });
      } else {
        put(ws, r, DL.qty, null, { fill: FILL.calc }); // AMOUNT / NBV modes plan no quantity (never invented)
      }
      if (qtyMode) {
        amt = (qty ?? 0) * rate;
        put(ws, r, DL.amt, formula(`${addr(DL.qty, r)}*${R}`, amt), { fill: FILL.calc, bold: true, numFmt: FMT.money });
      } else if (mode === "AMOUNT") {
        amt = line?.value ?? 0;
        put(ws, r, DL.amt, has && amt ? amt : null, { fill: inputFill, bold: true, numFmt: FMT.money });
      }
      if (mode === "NBV") {
        nbv = line?.value ?? 0;
        put(ws, r, DL.nbv, has && nbv ? nbv : null, { fill: inputFill, numFmt: FMT.money });
        amt = nbvPct > 0 ? nbv / nbvPct : "";
        put(ws, r, DL.amt, formula(`IF(${E}>0,${addr(DL.nbv, r)}/${E},"")`, amt), { fill: FILL.calc, bold: true, numFmt: FMT.money });
      } else {
        nbv = (typeof amt === "number" ? amt : 0) * nbvPct;
        put(ws, r, DL.nbv, formula(`${addr(DL.amt, r)}*${E}`, nbv), { fill: FILL.calc, numFmt: FMT.money });
      }
      add(DL.qty, r, qty ?? 0); add(DL.amt, r, typeof amt === "number" ? amt : 0); add(DL.nbv, r, nbv);
      // Months: recorded monthly plan quantity, sales quantity and uploaded sales value (data); everything else calculated.
      let liveQty = 0, actualQty = 0, actualAmt = 0;
      for (const m of DL.months) {
        const e = line?.months[m.key];
        const pq = e?.planQty ?? 0, sq = e?.saleQty ?? 0, sa = e?.saleAmount ?? 0;
        liveQty += pq; actualQty += sq; actualAmt += sa;
        put(ws, r, m.qty, e && pq ? pq : null, { numFmt: FMT.qty });
        put(ws, r, m.amt, formula(`${addr(m.qty, r)}*${R}`, pq * rate), { fill: FILL.calc, bold: true, numFmt: FMT.money });
        put(ws, r, m.nbv, formula(`${addr(m.amt, r)}*${E}`, pq * rate * nbvPct), { fill: FILL.calc, numFmt: FMT.money });
        put(ws, r, m.sale, e && sq ? sq : null, { numFmt: FMT.qty });
        put(ws, r, m.saleAmt, e && sa ? sa : null, { numFmt: FMT.money });
        put(ws, r, m.aNbv, formula(`${addr(m.saleAmt, r)}*${E}`, sa * nbvPct), { fill: FILL.calc, numFmt: FMT.money });
        put(ws, r, m.pend, formula(`${addr(m.qty, r)}-${addr(m.sale, r)}`, pq - sq), { fill: FILL.calc, numFmt: FMT.qty });
        put(ws, r, m.diffAmt, formula(`${addr(m.amt, r)}-${addr(m.saleAmt, r)}`, pq * rate - sa), { fill: FILL.calc, numFmt: FMT.money });
        add(m.qty, r, pq); add(m.amt, r, pq * rate); add(m.nbv, r, pq * rate * nbvPct); add(m.sale, r, sq); add(m.saleAmt, r, sa); add(m.aNbv, r, sa * nbvPct); add(m.pend, r, pq - sq); add(m.diffAmt, r, pq * rate - sa);
      }
      const monthSum = (pick: (m: MonthCols) => number) => (DL.months.length ? DL.months.map((m) => addr(pick(m), r)).join("+") : "0");
      put(ws, r, DL.aQty, formula(monthSum((m) => m.sale), actualQty), { fill: FILL.calc, numFmt: FMT.qty });
      put(ws, r, DL.aAmt, formula(monthSum((m) => m.saleAmt), actualAmt), { fill: FILL.calc, numFmt: FMT.money });
      put(ws, r, DL.aNbv, formula(`${addr(DL.aAmt, r)}*${E}`, actualAmt * nbvPct), { fill: FILL.calc, numFmt: FMT.money });
      put(ws, r, DL.lQty, formula(monthSum((m) => m.qty), liveQty), { fill: FILL.calc, bold: true, numFmt: FMT.qty });
      put(ws, r, DL.lAmt, formula(`${addr(DL.lQty, r)}*${R}`, liveQty * rate), { fill: FILL.calc, bold: true, numFmt: FMT.money });
      put(ws, r, DL.lNbv, formula(`${addr(DL.lAmt, r)}*${E}`, liveQty * rate * nbvPct), { fill: FILL.calc, bold: true, numFmt: FMT.money });
      const target = qty ?? 0;
      put(ws, r, DL.diff, formula(`N(${addr(DL.qty, r)})-${addr(DL.lQty, r)}`, target - liveQty), { fill: FILL.calc, bold: true, numFmt: FMT.qty });
      put(ws, r, DL.pend, formula(`N(${addr(DL.qty, r)})-${addr(DL.aQty, r)}`, target - actualQty), { fill: FILL.calc, bold: true, numFmt: FMT.qty });
      add(DL.aQty, r, actualQty); add(DL.aAmt, r, actualAmt); add(DL.aNbv, r, actualAmt * nbvPct);
      add(DL.lQty, r, liveQty); add(DL.lAmt, r, liveQty * rate); add(DL.lNbv, r, liveQty * rate * nbvPct); add(DL.diff, r, target - liveQty); add(DL.pend, r, target - actualQty);
      ws.getRow(r).height = 29;
    });
    writeTotals(ws, DL, totalRow, lastDataRow, totals);
    dealerValues.set(dealer.dealerId, { cells, totals });
  }

  /* ---- Product Plan: each figure = Σ of the dealer-sheet line results (3D sums over the dealer sheets) ---- */
  writeHeaderBlock(pp, PL, model, { title, nameBand: `PRODUCT PLAN — ALL DEALERS (${dealerSheets.length})`, info });
  setWidths(pp, PL);
  const effective = new Map<string, { name: string; technicalName: string | null; rows: number[] }>();
  for (const p of products) {
    const e = effective.get(p.effectiveId) ?? { name: p.effectiveName, technicalName: p.effectiveTechnicalName, rows: [] };
    e.rows.push(rowOf.get(p.productId)!);
    effective.set(p.effectiveId, e);
  }
  const effRows = [...effective.values()].sort((a, b) => a.name.localeCompare(b.name));
  const range = dealerSheets.length ? sheetRangeRef(dealerSheets[0]!.sheet, dealerSheets.at(-1)!.sheet) : "";
  // Product Plan column → the dealer-sheet column holding the same figure.
  const toDealerCol = new Map<number, number>(PL.valueCols.map((c, i) => [c, DL.valueCols[i]!]));
  const ppTotals = new Map<number, number>();
  const moneyCols = new Set([PL.amt, PL.nbv, PL.aAmt, PL.aNbv, PL.lAmt, PL.lNbv, ...PL.months.flatMap((m) => [m.amt, m.nbv, m.saleAmt, m.aNbv, m.diffAmt])]);
  const boldCols = new Set([PL.qty, PL.amt, PL.lQty, PL.lAmt, PL.lNbv, PL.diff, PL.pend, ...PL.months.map((m) => m.amt)]);
  effRows.forEach((e, i) => {
    const r = FIRST_ROW + i;
    put(pp, r, 1, i + 1, { bold: true });
    put(pp, r, 2, e.name, { bold: true, align: LEFT });
    put(pp, r, 3, e.technicalName ?? "", { align: LEFT });
    for (const c of PL.valueCols) {
      const dc = toDealerCol.get(c)!;
      let v = 0;
      for (const { dealer } of dealerSheets) for (const dr of e.rows) v += dealerValues.get(dealer.dealerId)!.cells.get(valueKey(dc, dr)) ?? 0;
      const value = range ? formula(`SUM(${e.rows.map((dr) => `${range}${addr(dc, dr)}`).join(",")})`, v) : 0;
      put(pp, r, c, value, { fill: FILL.calc, numFmt: moneyCols.has(c) ? FMT.money : FMT.qty, bold: boldCols.has(c) });
      ppTotals.set(c, (ppTotals.get(c) ?? 0) + v);
    }
    pp.getRow(r).height = 29;
  });
  writeTotals(pp, PL, FIRST_ROW + effRows.length, FIRST_ROW + effRows.length - 1, ppTotals);

  /* ---- Dealer Summary: every figure references its dealer sheet's total row ---- */
  [1, 2, 3].forEach((r) => ds.mergeCells(r, 1, r, 12));
  put(ds, 1, 1, "SEASON SALES PLAN", { bold: true, fill: FILL.summaryHead });
  put(ds, 2, 1, `${state ? `${state} ` : ""}Dealer Summary — ${model.officerName}`, { bold: true, fill: FILL.summaryHead });
  put(ds, 3, 1, `${model.seasonLabel.toUpperCase()}  ·  ${model.planLabel}`, { bold: true, fill: FILL.summaryTotal });
  ["S.No.", "Dealer Name", "Sales Plan", "Sales Plan NBV", "Live Month Plan", "Live Month NBV", "Actual Sales", "Actual NBV", "Sales Achieve. %", "NBV Achiev. %", "Planning Status", "No Plan Reason"]
    .forEach((t, i) => put(ds, 4, i + 1, t, { bold: true }));
  ds.getRow(4).height = 45;
  const firstDealerRow = 6;
  const sumCols: { col: number; dealerCol: number }[] = [
    { col: 3, dealerCol: DL.amt }, { col: 4, dealerCol: DL.nbv }, { col: 5, dealerCol: DL.lAmt }, { col: 6, dealerCol: DL.lNbv }, { col: 7, dealerCol: DL.aAmt }, { col: 8, dealerCol: DL.aNbv },
  ];
  const dsTotals = new Map<number, number>();
  const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);
  dealerSheets.forEach(({ dealer, sheet }, i) => {
    const r = firstDealerRow + i;
    const t = dealerValues.get(dealer.dealerId)!.totals;
    put(ds, r, 1, i + 1);
    put(ds, r, 2, dealer.name, { align: LEFT });
    for (const { col, dealerCol } of sumCols) {
      const v = t.get(dealerCol) ?? 0;
      put(ds, r, col, products.length ? formula(`${sheetRef(sheet)}${addr(dealerCol, totalRow)}`, v) : 0, { numFmt: FMT.money });
      dsTotals.set(col, (dsTotals.get(col) ?? 0) + v);
    }
    put(ds, r, 9, formula(`IF(C${r}=0,0,G${r}/C${r})`, ratio(t.get(DL.aAmt) ?? 0, t.get(DL.amt) ?? 0)), { numFmt: FMT.summaryPct });
    put(ds, r, 10, formula(`IF(D${r}=0,0,H${r}/D${r})`, ratio(t.get(DL.aNbv) ?? 0, t.get(DL.nbv) ?? 0)), { numFmt: FMT.summaryPct });
    put(ds, r, 11, dealer.status === "NO_PLAN" ? "No Plan" : dealer.status === "COMPLETED" ? "Completed" : "Remaining");
    put(ds, r, 12, dealer.status === "NO_PLAN" ? dealer.noPlanReason ?? "" : "", { align: LEFT });
  });
  const lastDealerRow = firstDealerRow + dealerSheets.length - 1;
  put(ds, 5, 1, null, { fill: FILL.summaryTotal });
  put(ds, 5, 2, "TOTAL", { bold: true, fill: FILL.summaryTotal });
  for (const { col } of sumCols) {
    put(ds, 5, col, dealerSheets.length ? formula(`SUM(${addr(col, firstDealerRow)}:${addr(col, lastDealerRow)})`, dsTotals.get(col) ?? 0) : 0, { bold: true, fill: FILL.summaryTotal, numFmt: FMT.money });
  }
  put(ds, 5, 9, formula("IF(C5=0,0,G5/C5)", ratio(dsTotals.get(7) ?? 0, dsTotals.get(3) ?? 0)), { bold: true, fill: FILL.summaryTotal, numFmt: FMT.summaryPct });
  put(ds, 5, 10, formula("IF(D5=0,0,H5/D5)", ratio(dsTotals.get(8) ?? 0, dsTotals.get(4) ?? 0)), { bold: true, fill: FILL.summaryTotal, numFmt: FMT.summaryPct });
  put(ds, 5, 11, null, { fill: FILL.summaryTotal }); put(ds, 5, 12, null, { fill: FILL.summaryTotal });
  [6, 34, 14, 14, 14, 14, 14, 14, 11, 11, 16, 30].forEach((width, i) => { ds.getColumn(i + 1).width = width; });

  return { workbook: wb, sheetNames: dealerSheets.map((d) => ({ dealerId: d.dealer.dealerId, sheet: d.sheet })) };
}

export async function seasonalPlanWorkbookBuffer(model: SeasonalExportModel): Promise<Buffer> {
  const { workbook } = buildSeasonalPlanWorkbook(model);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
