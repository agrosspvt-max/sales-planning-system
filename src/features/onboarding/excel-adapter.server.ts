import "server-only";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";
import { detectOfficerFromFilename } from "@/features/import/dealers/service.server";
import { MONTH_NAMES } from "@/lib/season-months";

/**
 * Excel onboarding adapter (Section 41). Extracts reusable MASTER data + a season hint
 * from the workbook. It is the first `OnboardingSource`; CSV/ERP/API/Manual adapters will
 * implement the same `OnboardingMasters` shape and feed the identical orchestrator.
 * Planning rows are resolved by the orchestrator via the existing seasonal parser.
 */
export interface OnboardingMasters {
  products: { name: string; technicalName: string | null; rate: number; nbvPercent: number }[];
  dealerNames: string[];
  officerName: string | null;
  seasonHint: { name: string; startMonth: number; startYear: number; endMonth: number; endYear: number };
}

const SKIP_SHEET = /price\s*list|product\s*plan|dealer\s*summary/i;
const PLACEHOLDER = /^\s*dealer\s+\d+\s*$/i;

function toNum(v: string | number | null): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Read the PRICELIST sheet into the product master (name, technical, rate, NBV%). */
function readPricelist(wb: ReturnType<typeof readWorkbook>): OnboardingMasters["products"] {
  const sheet = sheetNames(wb).find((n) => /price\s*list/i.test(n));
  if (!sheet) return [];
  const rows = sheetRows(wb, sheet);
  // Header row 0: SR.NO | PRODUCT NAME | TECHNICAL | RATE | %OF NBV
  const out: OnboardingMasters["products"] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const name = typeof row[1] === "string" ? row[1].trim() : row[1] == null ? "" : String(row[1]);
    if (!name) continue;
    const rate = toNum(row[3]);
    let nbv = toNum(row[4]);
    if (nbv > 1) nbv = nbv / 100; // accept 25 or 0.25
    out.push({
      name,
      technicalName: typeof row[2] === "string" ? row[2].trim() : null,
      rate,
      nbvPercent: nbv,
    });
  }
  return out;
}

/** Count month blocks + detect the start month from a dealer sheet header. */
function detectMonths(wb: ReturnType<typeof readWorkbook>): { startMonth: number; count: number } {
  const dealerSheet = sheetNames(wb).find((n) => !SKIP_SHEET.test(n) && !PLACEHOLDER.test(n));
  if (!dealerSheet) return { startMonth: 6, count: 6 };
  const rows = sheetRows(wb, dealerSheet);
  // Row index 2 (0-based) holds "Month N Name -June" labels; header row 2 holds repeated "QTY".
  const labelRow = rows[1] ?? [];
  let startMonth = 6;
  for (const cell of labelRow) {
    if (typeof cell === "string") {
      const m = cell.match(/month\s*1\s*name\s*-\s*([a-z]+)/i);
      if (m) {
        const idx = MONTH_NAMES.findIndex((n) => n.toLowerCase() === m[1].toLowerCase());
        if (idx >= 0) startMonth = idx + 1;
      }
    }
  }
  const headerRow = rows[2] ?? [];
  const qtyCols = headerRow.filter((c) => typeof c === "string" && c.trim().toLowerCase() === "qty").length;
  return { startMonth, count: qtyCols > 0 ? qtyCols : 6 };
}

function detectSeasonHint(
  wb: ReturnType<typeof readWorkbook>,
  filename: string,
): OnboardingMasters["seasonHint"] {
  // Name from the title cell "...(KHARIF)"; year from filename "26_27" / "26-27".
  let name = "Season";
  const first = sheetNames(wb)[0];
  const titleRows = first ? sheetRows(wb, first) : [];
  for (const row of titleRows.slice(0, 4)) {
    for (const cell of row) {
      if (typeof cell === "string") {
        const m = cell.match(/\(([A-Za-z ]+)\)/);
        if (m) name = m[1].trim().replace(/\b\w/g, (x) => x.toUpperCase());
      }
    }
  }
  const ym = filename.match(/(\d{2})[_-](\d{2})/);
  const startYear = ym ? 2000 + Number(ym[1]) : new Date().getFullYear();

  const { startMonth, count } = detectMonths(wb);
  const endAbs = startMonth - 1 + (count - 1);
  const endMonth = (endAbs % 12) + 1;
  const endYear = startYear + Math.floor(endAbs / 12);
  return { name, startMonth, startYear, endMonth, endYear };
}

export function extractExcelMasters(buffer: Buffer, filename: string): OnboardingMasters {
  const wb = readWorkbook(buffer);
  const names = sheetNames(wb);
  const dealerNames = names.filter((n) => !SKIP_SHEET.test(n) && !PLACEHOLDER.test(n) && n.trim());
  return {
    products: readPricelist(wb),
    dealerNames,
    officerName: detectOfficerFromFilename(filename),
    seasonHint: detectSeasonHint(wb, filename),
  };
}
