import "server-only";
import * as XLSX from "xlsx";

/**
 * Shared Excel reader for the import wizards. Uses SheetJS so both .xlsx and .xls
 * are supported. Files are parsed in memory and never persisted.
 */
export function readWorkbook(buffer: Buffer, opts?: { cellDates?: boolean }): XLSX.WorkBook {
  // cellDates converts date-formatted cells to JS Date objects (needed by the Aging Report,
  // whose due dates must be compared to a cutoff). Default off — unchanged for other importers.
  return XLSX.read(buffer, { type: "buffer", cellDates: opts?.cellDates ?? false });
}

export function sheetNames(wb: XLSX.WorkBook): string[] {
  return wb.SheetNames;
}

/** Rows of a sheet as an array of arrays (row 0 = header row). Blank rows dropped. */
export function sheetRows(wb: XLSX.WorkBook, name: string): (string | number | null)[][] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null }) as (
    | string
    | number
    | null
  )[][];
}

/** Read an uploaded file from multipart form data into a Buffer. */
export async function fileToBuffer(file: File): Promise<Buffer> {
  return Buffer.from(await file.arrayBuffer());
}
