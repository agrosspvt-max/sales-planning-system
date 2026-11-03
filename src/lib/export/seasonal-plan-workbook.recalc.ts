/**
 * Seasonal Plan Excel export — recalculation in a REAL spreadsheet engine (LibreOffice, headless). Generates representative workbooks (every
 * planning mode; 64 dealers with awkward names), lets LibreOffice open them with "always recalculate on load" (a throw-away profile) and save the
 * recalculated result, then checks:
 *   1. no formula evaluates to an error (#REF!, #VALUE!, #DIV/0!, #NAME? …) and the workbook has no external links;
 *   2. every formula's recalculated value equals the cached value written into the file (what a user sees on opening);
 *   3. after editing one dealer's planning input (the file's cached results left STALE on purpose), the recalculated dealer line, dealer total,
 *      Dealer Summary row, Product Plan row and grand totals move by exactly the expected amount, another dealer stays unchanged, and the
 *      achievement % follows — which only a real recalculation can produce.
 *
 *   node --import tsx src/lib/export/seasonal-plan-workbook.recalc.ts      (needs /Applications/LibreOffice.app)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import type { PlanningMode } from "@/lib/calc";
import { buildSeasonalPlanWorkbook, type SeasonalExportModel } from "./seasonal-plan-workbook";
import { fixture } from "./seasonal-plan-workbook.fixture";

const SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice";

/** LibreOffice profile: recalculate OOXML / ODF files on load ("Always"). */
const PROFILE_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`;

const A = (c: number, r: number) => { let s = ""; for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return `${s}${r}`; };
const colOf = (ws: ExcelJS.Worksheet, header: string) => { for (let c = 1; c <= ws.columnCount; c++) if (ws.getCell(3, c).value === header) return c; throw new Error(`${ws.name}: ${header}`); };
const resultOf = (v: ExcelJS.CellValue): number | { error: string } => {
  if (typeof v === "number") return v;
  if (v == null) return 0;
  if (typeof v === "object" && "error" in v) return { error: String((v as { error: string }).error) };
  if (typeof v === "object" && "result" in v) {
    const r = (v as ExcelJS.CellFormulaValue).result as unknown;
    if (r && typeof r === "object" && "error" in (r as object)) return { error: String((r as { error: string }).error) };
    return typeof r === "number" ? r : 0;
  }
  return 0;
};

interface Case { label: string; model: SeasonalExportModel }

async function main() {
  if (!existsSync(SOFFICE)) { console.error("LibreOffice is not installed at /Applications/LibreOffice.app — recalculation check NOT run."); process.exit(2); }
  const dir = mkdtempSync(join(tmpdir(), "seasonal-recalc-"));
  const profile = join(dir, "profile");
  mkdirSync(join(profile, "user"), { recursive: true });
  writeFileSync(join(profile, "user", "registrymodifications.xcu"), PROFILE_XCU);
  const inDir = join(dir, "in"), outDir = join(dir, "out");
  mkdirSync(inDir); mkdirSync(outDir);

  const cases: Case[] = (["PACK_SIZE", "TOTAL_QUANTITY", "AMOUNT", "NBV"] as PlanningMode[]).map((mode) => ({ label: mode, model: fixture(mode) }));
  const awkward = ["Ram's Agro: Shop/1*", "ram's agro shop 1", "PRICELIST", "product plan", "History", "A".repeat(60), "  'Quoted'  ", "[Bracket]?", ...Array.from({ length: 56 }, (_, i) => `Dealer ${i}`)];
  cases.push({ label: "PACK_SIZE-64-dealers-awkward-names", model: fixture("PACK_SIZE", { names: awkward }) });

  type Check = { label: string; expected: Map<string, number>; targets: { key: string; expect: number }[]; sheets: string[] };
  const checks: Check[] = [];
  for (const { label, model } of cases) {
    const { workbook, sheetNames } = buildSeasonalPlanWorkbook(model);
    // (1)(2) the file as exported
    const expected = new Map<string, number>();
    for (const ws of workbook.worksheets) ws.eachRow((row) => row.eachCell((c) => {
      const v = c.value as ExcelJS.CellFormulaValue | null;
      if (v && typeof v === "object" && "formula" in v) expected.set(`${ws.name}!${c.address}`, typeof v.result === "number" ? v.result : 0);
    }));
    writeFileSync(join(inDir, `${label}.xlsx`), Buffer.from(await workbook.xlsx.writeBuffer()));
    assert.ok(!execFileSync("unzip", ["-l", join(inDir, `${label}.xlsx`)], { encoding: "utf8" }).includes("externalLink"), `${label}: no external links`);

    // (3) the same workbook with ONE dealer input edited and every cached result left stale.
    const dealer = model.dealers.find((d) => d.status === "COMPLETED")!;
    const ws = workbook.getWorksheet(sheetNames.find((s) => s.dealerId === dealer.dealerId)!.sheet)!;
    const line = dealer.lines[model.products[0]!.productId]!;
    const r = 4, delta = 10;
    const inputCol = model.mode === "PACK_SIZE" ? colOf(ws, model.packs[0]!.name) : model.mode === "TOTAL_QUANTITY" ? colOf(ws, "TOTAL QTY") : model.mode === "AMOUNT" ? colOf(ws, "PLANNED AMOUNT") : colOf(ws, "PLAN NBV");
    const old = model.mode === "PACK_SIZE" ? line.packs[model.packs[0]!.id] ?? 0 : line.value;
    ws.getCell(r, inputCol).value = old + delta;
    const dAmt = model.mode === "PACK_SIZE" || model.mode === "TOTAL_QUANTITY" ? delta * line.rate : model.mode === "AMOUNT" ? delta : line.nbvPercent > 0 ? delta / line.nbvPercent : 0;
    const dNbv = model.mode === "NBV" ? delta : dAmt * line.nbvPercent;
    const amtCol = colOf(ws, model.mode === "AMOUNT" ? "PLANNED AMOUNT" : "Total Amount"), nbvCol = colOf(ws, "PLAN NBV");
    const totalRow = 4 + model.products.length;
    const pp = workbook.getWorksheet("Product Plan")!;
    const findRow = (sheet: ExcelJS.Worksheet, col: number, text: string, from: number) => { for (let rr = from; rr < from + 500; rr++) if (sheet.getCell(rr, col).value === text) return rr; throw new Error(text); };
    const ppRow = findRow(pp, 2, model.products[0]!.effectiveName, 4), ppTotal = findRow(pp, 1, "TOTAL", 4);
    const ppAmt = colOf(pp, model.mode === "AMOUNT" ? "PLANNED AMOUNT" : "Total Amount"), ppNbv = colOf(pp, "PLAN NBV");
    const ds = workbook.getWorksheet("Dealer Summary")!;
    const dsRow = findRow(ds, 2, dealer.name, 6);
    const other = model.dealers.find((d) => d.dealerId !== dealer.dealerId)!;
    const otherRow = findRow(ds, 2, other.name, 6);
    const exp = (s: string, a: string) => expected.get(`${s}!${a}`) ?? 0;
    const planAfter = exp("Dealer Summary", `C${dsRow}`) + dAmt;
    const targets = [
      { key: `${ws.name}!${A(amtCol, r)}`, d: dAmt }, { key: `${ws.name}!${A(nbvCol, r)}`, d: dNbv },
      { key: `${ws.name}!${A(amtCol, totalRow)}`, d: dAmt }, { key: `${ws.name}!${A(nbvCol, totalRow)}`, d: dNbv },
      { key: `Dealer Summary!C${dsRow}`, d: dAmt }, { key: `Dealer Summary!D${dsRow}`, d: dNbv }, { key: "Dealer Summary!C5", d: dAmt }, { key: "Dealer Summary!D5", d: dNbv },
      { key: `Dealer Summary!C${otherRow}`, d: 0 },
      { key: `Product Plan!${A(ppAmt, ppRow)}`, d: dAmt }, { key: `Product Plan!${A(ppNbv, ppRow)}`, d: dNbv },
      { key: `Product Plan!${A(ppAmt, ppTotal)}`, d: dAmt }, { key: `Product Plan!${A(ppNbv, ppTotal)}`, d: dNbv },
    ].map((t) => ({ key: t.key, expect: (expected.get(t.key) ?? 0) + t.d }));
    targets.push({ key: `Dealer Summary!I${dsRow}`, expect: planAfter === 0 ? 0 : exp("Dealer Summary", `G${dsRow}`) / planAfter });
    writeFileSync(join(inDir, `${label}-edited.xlsx`), Buffer.from(await workbook.xlsx.writeBuffer()));
    checks.push({ label, expected, targets, sheets: workbook.worksheets.map((w) => w.name) });
  }

  // LibreOffice: open (recalculating everything) and save every file.
  const t0 = Date.now();
  const files = cases.flatMap((c) => [join(inDir, `${c.label}.xlsx`), join(inDir, `${c.label}-edited.xlsx`)]);
  execFileSync(SOFFICE, [`-env:UserInstallation=file://${profile}`, "--headless", "--norestore", "--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", outDir, ...files], { stdio: "pipe", timeout: 900_000 });
  const loMs = Date.now() - t0;

  for (const check of checks) {
    for (const [suffix, kind] of [["", "as exported"], ["-edited", "after a dealer edit"]] as const) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(readFileSync(join(outDir, `${check.label}${suffix}.xlsx`)) as unknown as ArrayBuffer);
      assert.deepEqual(wb.worksheets.map((w) => w.name), check.sheets, `${check.label}: sheet order survives`);
      const errors: string[] = [];
      let formulas = 0, worst = 0;
      for (const ws of wb.worksheets) ws.eachRow((row) => row.eachCell((c) => {
        const v = c.value;
        if (!(v && typeof v === "object" && ("formula" in v || "sharedFormula" in v))) return;
        formulas++;
        const res = resultOf(v);
        if (typeof res === "object") { errors.push(`${ws.name}!${c.address} ${res.error}`); return; }
        if (suffix === "") {
          const e = check.expected.get(`${ws.name}!${c.address}`) ?? 0;
          const rel = Math.abs(res - e) / Math.max(1, Math.abs(e));
          worst = Math.max(worst, rel);
          if (rel > 1e-9) errors.push(`${ws.name}!${c.address}: LibreOffice ${res} ≠ file ${e}`);
        }
      }));
      assert.deepEqual(errors.slice(0, 10), [], `${check.label} (${kind}): no formula errors / mismatches`);
      if (suffix === "") {
        assert.equal(formulas, check.expected.size, `${check.label}: every formula survived`);
        console.log(`  ${check.label}: ${formulas} formulas recalculated by LibreOffice — no errors, all equal the file's cached values (worst rel. diff ${worst.toExponential(1)})`);
      } else {
        for (const t of check.targets) {
          const [sheet, a] = [t.key.slice(0, t.key.lastIndexOf("!")), t.key.slice(t.key.lastIndexOf("!") + 1)];
          const got = resultOf(wb.getWorksheet(sheet)!.getCell(a).value) as number;
          assert.ok(Math.abs(got - t.expect) <= 1e-6 * Math.max(1, Math.abs(t.expect)), `${check.label}: after the edit ${t.key} = ${got}, expected ${t.expect}`);
        }
        console.log(`  ${check.label}: editing one dealer input recalculated the line, dealer total, Dealer Summary row + total + achievement and Product Plan row + total; another dealer unchanged`);
      }
    }
  }
  console.log(`seasonal-plan-workbook.recalc.ts — LibreOffice recalculation passed (${files.length} workbooks, LibreOffice ${Math.round(loMs / 1000)} s)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
