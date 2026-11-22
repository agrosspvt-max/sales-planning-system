import type { DealerAuditSummary } from "./dealer-audit";

export async function exportMissingDealers(
  summary: DealerAuditSummary,
  completedAt: string | null,
) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["No.", "Tally dealer", "Tally group"],
    ...summary.unmatched.map((row, index) => [index + 1, row.name, row.groups.join(", ")]),
  ]);
  sheet["!cols"] = [{ wch: 8 }, { wch: 75 }, { wch: 40 }];
  sheet["!autofilter"] = { ref: sheet["!ref"]! };
  XLSX.utils.book_append_sheet(workbook, sheet, "Missing Dealers");
  const details = XLSX.utils.aoa_to_sheet([
    ["Scan details", "Value"],
    [
      "Last successful scan (IST)",
      completedAt
        ? new Date(completedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : "Not available",
    ],
    ["Checked", summary.scanned],
    ["Matched", summary.matched],
    ["Unmatched", summary.unmatched.length],
  ]);
  details["!cols"] = [{ wch: 30 }, { wch: 38 }];
  XLSX.utils.book_append_sheet(workbook, details, "Scan Details");
  XLSX.writeFile(workbook, "Tally-Missing-Dealers.xlsx", { compression: true });
}
