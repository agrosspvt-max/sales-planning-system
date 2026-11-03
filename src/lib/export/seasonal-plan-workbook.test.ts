/**
 * Seasonal Plan Excel export — the pure workbook builder (no database). Fixtures cover every planning mode, per-line saved prices that differ across
 * dealers and from the price list, merged products, negative actual sales, zero plans / missing monthly data, No Plan and unfinished dealers,
 * more than 50 dealers, and long / duplicate / special-character dealer names. Cached formula results are checked against the system's own
 * calculation (figuresForMode — the same rule the seasonal workspace uses); formula structure is checked for direction (no circular references).
 * A real spreadsheet recalculation runs separately (seasonal-plan-workbook.recalc.ts, LibreOffice).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { figuresForMode, type PlanningMode } from "@/lib/calc";
import { buildSeasonalPlanWorkbook, type SeasonalExportModel } from "./seasonal-plan-workbook";
import { fixture } from "./seasonal-plan-workbook.fixture";
import { cleanSheetName, SheetNameRegistry, sheetRangeRef, sheetRef } from "./sheet-names";
import { crc32, zipStore } from "./zip-store";

const near = (a: number, b: number, m: string) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${m}: ${a} ≠ ${b}`);

/** The screen's per-line figures for a fixture line (figuresForMode — the seasonal workspace rule). */
function lineFig(model: SeasonalExportModel, line: SeasonalExportModel["dealers"][number]["lines"][string]) {
  const value = model.mode === "PACK_SIZE" ? Object.values(line.packs).reduce((a, b) => a + b, 0) : line.value;
  return figuresForMode(model.mode, value, line.rate, line.nbvPercent);
}
const cellNum = (v: ExcelJS.CellValue): number => {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && "result" in v) return typeof v.result === "number" ? v.result : 0;
  return 0;
};
const formulaOf = (v: ExcelJS.CellValue): string | null => (v && typeof v === "object" && "formula" in v ? (v as ExcelJS.CellFormulaValue).formula : null);
function headerCol(ws: ExcelJS.Worksheet, text: string, nth = 1): number {
  let seen = 0;
  for (let c = 1; c <= ws.columnCount; c++) if (String(ws.getCell(3, c).value ?? "") === text && ++seen === nth) return c;
  throw new Error(`no header ${text} on ${ws.name}`);
}

function check(mode: PlanningMode) {
  const model = fixture(mode);
  const { workbook, sheetNames } = buildSeasonalPlanWorkbook(model);
  const names = workbook.worksheets.map((w) => w.name);
  assert.deepEqual(names.slice(0, 3), ["PRICELIST", "Product Plan", "Dealer Summary"], `${mode}: fixed sheet order`);
  assert.deepEqual(names.slice(3), model.dealers.map((d) => d.name), `${mode}: one sheet per dealer, alphabetical`);
  assert.equal(sheetNames.length, model.dealers.length);

  const productRows = model.products.map((p, i) => ({ p, r: 4 + i }));
  // Dealer sheets: rates come from PRICELIST (saved price where it differs), and every figure equals the screen's figure for that line.
  for (const d of model.dealers) {
    const ws = workbook.getWorksheet(d.name)!;
    const cAmt = headerCol(ws, mode === "AMOUNT" ? "PLANNED AMOUNT" : "Total Amount"), cNbv = headerCol(ws, "PLAN NBV"), cRate = headerCol(ws, "RATE (SAVED PLAN PRICE)");
    const cAAmt = headerCol(ws, "AMOUNT", 1), cAQty = headerCol(ws, "ACTUAL SALES QTY");
    let amtT = 0, nbvT = 0, actT = 0;
    for (const { p, r } of productRows) {
      const line = d.lines[p.productId]!;
      const fig = lineFig(model, line);
      const rateF = formulaOf(ws.getCell(r, cRate).value)!;
      assert.match(rateF, /^PRICELIST!\$[A-Z]+\$\d+$/, "the line price is a PRICELIST reference");
      near(cellNum(ws.getCell(r, cRate).value), line.rate, `${mode} ${d.name} ${p.name} rate`);
      near(cellNum(ws.getCell(r, cAmt).value), fig.amount ?? 0, `${mode} ${d.name} ${p.name} amount`);
      near(cellNum(ws.getCell(r, cNbv).value), fig.nbv ?? 0, `${mode} ${d.name} ${p.name} nbv`);
      const actual = Object.values(line.months).reduce((s, m) => s + m.saleAmount, 0);
      near(cellNum(ws.getCell(r, cAAmt).value), actual, `${mode} actual amount = uploaded sales value (incl. negative)`);
      assert.equal(formulaOf(ws.getCell(r, cAAmt).value)!.includes("$"), false, "actual amount sums the month sales values (no price)");
      amtT += fig.amount ?? 0; nbvT += fig.nbv ?? 0; actT += actual;
      if (mode === "NBV" && line.nbvPercent === 0) {
        const v = ws.getCell(r, cAmt).value as ExcelJS.CellFormulaValue;
        assert.ok(v.result === "" || v.result === undefined, "NBV mode, NBV % 0: amount stays blank (not invented)");
        assert.match(v.formula, /^IF\([A-Z]+\d+>0,/, "…via the engine's NBV % > 0 guard");
      }
      if (mode === "AMOUNT" || mode === "NBV") assert.equal(ws.getCell(r, headerCol(ws, "TOTAL QTY")).value, null, `${mode}: no quantity is invented`);
      for (let c = 1; c <= ws.columnCount; c++) {
        const f = formulaOf(ws.getCell(r, c).value);
        if (f) assert.ok(!/Product Plan|Dealer Summary/.test(f), "dealer sheets never reference the summaries (one dependency direction)");
      }
    }
    const totalRow = 4 + model.products.length;
    near(cellNum(ws.getCell(totalRow, cAmt).value), amtT, `${mode} ${d.name} total amount`);
    near(cellNum(ws.getCell(totalRow, cNbv).value), nbvT, `${mode} ${d.name} total nbv`);
    near(cellNum(ws.getCell(totalRow, cAAmt).value), actT, `${mode} ${d.name} total actual`);
    assert.match(formulaOf(ws.getCell(totalRow + 2, cAAmt).value)!, /^IF\([A-Z]+\d+=0,0,/, "achievement guards a zero plan");
    assert.equal(cellNum(ws.getCell(4, cAQty).value) >= 0, true);
    assert.ok(String(ws.getCell(2, 4).value).includes(d.name), "the full dealer name is shown inside the sheet");
    if (d.status === "NO_PLAN") assert.ok(String(ws.getCell(2, 4).value).includes("No Plan — Dealer closed for the season"), "No Plan + reason preserved");
    if (d.status === "REMAINING") assert.ok(String(ws.getCell(2, 4).value).includes("Remaining"), "an unfinished dealer is Remaining, never No Plan");
  }

  // Product Plan: rows by EFFECTIVE product (merged source folded into its survivor), alphabetical, each a 3D sum of the dealer line results.
  const pp = workbook.getWorksheet("Product Plan")!;
  const ppNames = [4, 5, 6].map((r) => String(pp.getCell(r, 2).value));
  assert.deepEqual(ppNames, ["AGORA", "TANDAB", "ZERO NBV"], "alphabetical effective products; TAANDAB folds into TANDAB (no duplicate row)");
  const ppAmt = headerCol(pp, mode === "AMOUNT" ? "PLANNED AMOUNT" : "Total Amount");
  const tandabF = formulaOf(pp.getCell(5, ppAmt).value)!;
  const range = sheetRangeRef(model.dealers[0]!.name, model.dealers.at(-1)!.name);
  assert.ok(tandabF.startsWith(`SUM(${range}`) && tandabF.split(range).length === 3, "merged product = Σ of BOTH raw lines' amounts across all dealer sheets (never qty × one price)");
  const expectAmt = (effId: string) => model.dealers.reduce((s, d) => s + model.products.filter((p) => p.effectiveId === effId).reduce((t, p) => t + (lineFig(model, d.lines[p.productId]!).amount ?? 0), 0), 0);
  near(cellNum(pp.getCell(5, ppAmt).value), expectAmt("p-tandab"), `${mode} Product Plan TANDAB amount = Σ line amounts at each line's saved price`);
  const grand = model.dealers.reduce((s, d) => s + Object.values(d.lines).reduce((t, l) => t + (lineFig(model, l).amount ?? 0), 0), 0);
  near(cellNum(pp.getCell(7, ppAmt).value), grand, `${mode} Product Plan grand total`);
  for (let r = 4; r <= 6; r++) for (let c = 4; c <= pp.columnCount; c++) { const f = formulaOf(pp.getCell(r, c).value); if (f) assert.ok(f.startsWith("SUM('"), "Product Plan cells are calculated from the dealer sheets"); }

  // Dealer Summary: totals at the top (as the reference), every figure referencing the dealer sheet's total row; achievement with the zero-plan rule.
  const ds = workbook.getWorksheet("Dealer Summary")!;
  near(cellNum(ds.getCell(5, 3).value), grand, `${mode} Dealer Summary grand Sales Plan = Product Plan grand total`);
  model.dealers.forEach((d, i) => {
    const r = 6 + i;
    assert.equal(String(ds.getCell(r, 2).value), d.name);
    assert.ok(formulaOf(ds.getCell(r, 3).value)!.startsWith(sheetRef(d.name)), "Sales Plan references the dealer sheet's total row");
    assert.equal(formulaOf(ds.getCell(r, 9).value), `IF(C${r}=0,0,G${r}/C${r})`);
    assert.equal(String(ds.getCell(r, 11).value), d.status === "NO_PLAN" ? "No Plan" : d.status === "COMPLETED" ? "Completed" : "Remaining");
    if (d.status !== "COMPLETED") near(cellNum(ds.getCell(r, 9).value), 0, "zero plan → achievement 0");
  });

  // PRICELIST: the state price list (0.255 = 25.5% as a fraction) plus the saved plan prices that differ from it.
  const price = workbook.getWorksheet("PRICELIST")!;
  assert.deepEqual([2, 3, 4].map((r) => price.getCell(r, 2).value), ["AGORA", "TANDAB", "ZERO NBV"]);
  assert.equal(price.getCell(2, 5).value, 0.255);
  assert.equal(price.getCell(2, 5).numFmt, "0.00%");
  const saved = [] as string[];
  for (let r = 2; price.getCell(r, 8).value; r++) saved.push(`${price.getCell(r, 8).value}@${price.getCell(r, 10).value}`);
  assert.ok(saved.includes("TANDAB@1970.15") && saved.includes("TAANDAB@1800"), "saved prices that differ from the price list are kept (never replaced by today's price)");
  assert.ok(!saved.some((x) => x.startsWith("AGORA@")), "a line priced exactly at the price list references the price list itself");
}

async function main() {
  for (const mode of ["PACK_SIZE", "TOTAL_QUANTITY", "AMOUNT", "NBV"] as PlanningMode[]) check(mode);

  // > 50 dealers, duplicate / long / special-character names, reserved-name collisions — stable ids, unique valid tab names, quoted references.
  const awkward = ["Ram's Agro: Shop/1*", "ram's agro shop 1", "PRICELIST", "product plan", "History", "A".repeat(60), "  'Quoted'  ", "[Bracket]?", ...Array.from({ length: 52 }, (_, i) => `Dealer ${i}`)];
  const big = fixture("PACK_SIZE", { names: awkward });
  const { workbook, sheetNames } = buildSeasonalPlanWorkbook(big);
  const tabs = workbook.worksheets.map((w) => w.name);
  assert.equal(tabs.length, 3 + awkward.length, "every dealer gets a sheet (more than 50)");
  assert.equal(new Set(tabs.map((t) => t.toLowerCase())).size, tabs.length, "tab names unique ignoring case");
  for (const t of tabs) {
    assert.ok(t.length >= 1 && t.length <= 31 && !/[:\\/?*[\]]/.test(t) && !t.startsWith("'") && !t.endsWith("'"), `valid tab name: ${t}`);
    assert.notEqual(t.toLowerCase(), "history");
  }
  assert.equal(new Set(sheetNames.map((s) => s.dealerId)).size, awkward.length, "mapping is by dealer id");
  const longDealer = big.dealers.find((d) => d.name === "A".repeat(60))!;
  const longTab = sheetNames.find((s) => s.dealerId === longDealer.dealerId)!.sheet;
  assert.ok(String(workbook.getWorksheet(longTab)!.getCell(2, 4).value).includes("A".repeat(60)), "the full name stays visible inside a shortened tab");
  const ds = workbook.getWorksheet("Dealer Summary")!;
  for (let r = 6; r < 6 + big.dealers.length; r++) {
    const f = formulaOf(ds.getCell(r, 3).value)!;
    const sheet = sheetNames.find((s) => s.dealerId === big.dealers[r - 6]!.dealerId)!.sheet;
    assert.ok(f.startsWith(sheetRef(sheet)), `summary row references its own dealer sheet by mapping: ${f}`);
  }
  assert.equal(sheetRef("Ram's Agro"), "'Ram''s Agro'!");
  assert.equal(sheetRangeRef("Ram's", "Zed"), "'Ram''s:Zed'!");
  assert.equal(cleanSheetName("a:b/c?d*e[f]g\\h"), "a b c d e f g h");
  const reg = new SheetNameRegistry(["PRICELIST"]);
  assert.equal(reg.allocate("pricelist"), "pricelist (2)");
  assert.equal(reg.allocate("B".repeat(40)).length, 31);
  assert.equal(reg.allocate("B".repeat(40)), `${"B".repeat(27)} (2)`);

  // A plan with no dealers / no products still produces a valid, formula-error-free workbook.
  const empty = { ...fixture("PACK_SIZE"), dealers: [], products: [] };
  const e = buildSeasonalPlanWorkbook(empty).workbook;
  assert.deepEqual(e.worksheets.map((w) => w.name), ["PRICELIST", "Product Plan", "Dealer Summary"]);

  // Round trip through a real file, and the ZIP container (one .xlsx per officer).
  const dir = mkdtempSync(join(tmpdir(), "seasonal-export-"));
  const one = Buffer.from(await buildSeasonalPlanWorkbook(fixture("TOTAL_QUANTITY")).workbook.xlsx.writeBuffer());
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.load(one as unknown as ArrayBuffer);
  assert.deepEqual(reread.worksheets.slice(0, 3).map((w) => w.name), ["PRICELIST", "Product Plan", "Dealer Summary"]);
  const zip = zipStore([{ name: "Seasonal Plan - A - Kharif 2026 - v1.xlsx", data: one }, { name: "Seasonal Plan - Bé - Kharif 2026 - v2.xlsx", data: one }]);
  writeFileSync(join(dir, "bundle.zip"), zip);
  const test = execFileSync("unzip", ["-t", join(dir, "bundle.zip")], { encoding: "utf8" });
  assert.match(test, /No errors detected/, "the ZIP is valid");
  const listed = execFileSync("python3", ["-c", "import sys,zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", join(dir, "bundle.zip")], { encoding: "utf8" });
  assert.match(listed, /Seasonal Plan - Bé - Kharif 2026 - v2\.xlsx/, "UTF-8 file names (general-purpose flag bit 11)");
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "CRC-32 check value");

  console.log("seasonal-plan-workbook.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
