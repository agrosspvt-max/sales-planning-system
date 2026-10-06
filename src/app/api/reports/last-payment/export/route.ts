import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, ApiError } from "@/lib/http";
import { getLastPaymentReportExport } from "@/features/reports/last-payment-report.server";
import { EXPORT_COLUMNS, NO_EXPORT_DATA_MESSAGE, formatLastUpdate, parseLastPaymentReportParams, toExportRows } from "@/lib/last-payment-report";
import { buildReportXlsx } from "@/lib/export/report-xlsx";

/**
 * Last Payment Report → Excel. Same server-side mechanism as every other export (ExcelJS via buildReportXlsx). It re-runs the
 * report's own pipeline with the CURRENT query parameters (search, Status/State/Territory/Sales Officer/Party, Payment Aging, Days
 * sort), under the caller's session scope — nothing here accepts an officer/scope parameter — and returns EVERY matching row,
 * not one page. Read-only.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth();
    const params = parseLastPaymentReportParams(req.nextUrl.searchParams);
    const { rows, lastUpdate } = await getLastPaymentReportExport(ctx, params);
    if (rows.length === 0) return NextResponse.json({ error: NO_EXPORT_DATA_MESSAGE }, { status: 422 });
    const buffer = await buildReportXlsx({
      type: "dealer", kind: "summary", title: "Last Payment Report",
      columns: EXPORT_COLUMNS.map((c) => ({ ...c })),
      rows: toExportRows(rows), totals: null, drillChild: null,
      meta: { seasonName: "", filters: [] }, sort: { key: "days", dir: params.sort === "days_asc" ? "asc" : "desc" },
    }, { metaLines: [`Last Update: ${formatLastUpdate(lastUpdate) ?? "—"}`] });
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="Last_Payment_Report.xlsx"',
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "Failed to export report" }, { status: 500 });
  }
}
