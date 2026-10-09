import "server-only";
import ExcelJS from "exceljs";
import { CN_EXPORT_COLUMNS, type CnExportRow } from "@/lib/cn-request";

/** The CN Requests export workbook: a bold header row (row 1) with the five fixed columns, then one row per request. No title/meta rows. */
export async function buildCnRequestsXlsx(rows: CnExportRow[], sheetName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sales Planning System";
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.columns = CN_EXPORT_COLUMNS.map((c) => ({ header: c.label, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { horizontal: "left" };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) ws.addRow({ dealer: row.dealer, cnType: row.cnType, employeeName: row.employeeName, state: row.state, territory: row.territory }); // keyed → always the column order above
  return Buffer.from(await wb.xlsx.writeBuffer());
}
