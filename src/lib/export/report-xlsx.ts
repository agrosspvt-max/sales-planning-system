import "server-only";
import ExcelJS from "exceljs";
import type { CellFormat, ReportPayload } from "@/features/reports/types";

const NUM_FMT: Record<CellFormat, string | undefined> = {
  text: undefined,
  number: "#,##0",
  currency: '"₹"#,##0.00',
  percent: "0.0%",
};

/**
 * Build an .xlsx workbook from a ReportPayload. The export is format-specific but
 * consumes the same ReportPayload the report logic produces, so CSV/PDF exporters
 * can be added later without changing the report service.
 */
export async function buildReportXlsx(payload: ReportPayload): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sales Planning System";
  wb.created = new Date();
  const ws = wb.addWorksheet(payload.title.slice(0, 31));

  const colCount = payload.columns.length;
  const merge = (row: number) => ws.mergeCells(row, 1, row, colCount);

  // Title
  merge(1);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = payload.title;
  titleCell.font = { bold: true, size: 14 };

  // Metadata lines
  merge(2);
  ws.getCell(2, 1).value = `Season: ${payload.meta.seasonName || "—"}`;
  merge(3);
  ws.getCell(3, 1).value = `Generated: ${new Date().toLocaleString("en-IN")}`;
  merge(4);
  ws.getCell(4, 1).value =
    payload.meta.filters.length > 0 ? `Filters: ${payload.meta.filters.join("; ")}` : "Filters: none";

  const headerRow = 6;

  // Header
  payload.columns.forEach((c, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
    cell.alignment = { horizontal: c.format === "text" ? "left" : "right" };
  });

  // Rows
  payload.rows.forEach((row, r) => {
    payload.columns.forEach((c, i) => {
      const cell = ws.getCell(headerRow + 1 + r, i + 1);
      cell.value = row[c.key] as string | number;
      if (NUM_FMT[c.format]) cell.numFmt = NUM_FMT[c.format]!;
      cell.alignment = { horizontal: c.format === "text" ? "left" : "right" };
    });
  });

  // Totals
  if (payload.totals) {
    const totalRowIndex = headerRow + 1 + payload.rows.length;
    payload.columns.forEach((c, i) => {
      const cell = ws.getCell(totalRowIndex, i + 1);
      if (i === 0) {
        cell.value = "Total";
      } else if (c.key in payload.totals!) {
        cell.value = payload.totals![c.key];
        if (NUM_FMT[c.format]) cell.numFmt = NUM_FMT[c.format]!;
      }
      cell.font = { bold: true };
      cell.alignment = { horizontal: c.format === "text" ? "left" : "right" };
    });
  }

  // Auto-size columns based on content length.
  payload.columns.forEach((c, i) => {
    let max = c.label.length;
    for (const row of payload.rows) {
      const v = row[c.key];
      const len = c.format === "currency" ? String(v).length + 3 : String(v).length;
      if (len > max) max = len;
    }
    ws.getColumn(i + 1).width = Math.min(40, Math.max(12, max + 2));
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
