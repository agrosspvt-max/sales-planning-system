import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, ApiError } from "@/lib/http";
import { listBillingExceptionsExport } from "@/features/reports/billing-exception.server";
import { EXCEPTION_EXPORT_COLUMNS, parseExceptionView } from "@/lib/billing-exception";
import { NO_EXPORT_DATA_MESSAGE, formatLastUpdate, parseLastPaymentReportParams } from "@/lib/last-payment-report";
import { dealerStatusLabel } from "@/lib/dealer-status";
import { buildReportXlsx } from "@/lib/export/report-xlsx";

/**
 * Billing Exception (Current | History) → Excel: the COMPLETE filtered result of the view under the caller's session scope. History is written from the
 * stored snapshots; Current from the live report values. Read-only.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth();
    const view = parseExceptionView(req.nextUrl.searchParams.get("view"));
    const params = parseLastPaymentReportParams(req.nextUrl.searchParams);
    const { rows, lastUpdate } = await listBillingExceptionsExport(ctx, view, params);
    if (rows.length === 0) return NextResponse.json({ error: NO_EXPORT_DATA_MESSAGE }, { status: 422 });
    const title = view === "history" ? "Billing Exception History" : "Billing Exception Current";
    const buffer = await buildReportXlsx({
      type: "dealer", kind: "summary", title,
      // Current: the running Days and, separately labelled, the Days frozen on each exception. History: only its frozen Days.
      columns: EXCEPTION_EXPORT_COLUMNS.filter((c) => view === "current" || c.key !== "frozenDays").map((c) => ({ ...c, label: view === "current" && c.key === "days" ? "Current Days" : c.label })),
      rows: rows.map((r) => ({
        id: r.exceptionId, party: r.party, status: dealerStatusLabel(r.status), state: r.state ?? "", territory: r.territory ?? "", salesOfficer: r.salesOfficer ?? "",
        lastPaymentDate: r.lastPaymentDate ?? "", amount: r.amount ?? "", days: r.days ?? "", frozenDays: r.frozenDays ?? "", billingDate: r.billingDate, billNo: r.billNo, authPerson: r.authPerson,
        exceptionStatus: r.exceptionStatus === "CURRENT" ? "Current" : "Resolved",
        billingAmount: r.billingAmount ?? "", paymentCondition: r.paymentCondition === "YES" ? "Yes" : r.paymentCondition === "NO" ? "No" : "", paymentDate: r.paymentDate ?? "",
      })),
      totals: null, drillChild: null, meta: { seasonName: "", filters: [] }, sort: { key: "days", dir: params.sort === "days_asc" ? "asc" : "desc" },
    }, { metaLines: [`Last Update: ${formatLastUpdate(lastUpdate) ?? "—"}`] });
    return new NextResponse(buffer, {
      status: 200,
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="Billing_Exception_${view === "history" ? "History" : "Current"}.xlsx"` },
    });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "Failed to export report" }, { status: 500 });
  }
}
