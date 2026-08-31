import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, ApiError } from "@/lib/http";
import { buildReportXlsx } from "@/lib/export/report-xlsx";
import type { ReportColumn, ReportPayload, ReportRow } from "@/features/reports/types";
import {
  dealerFollowUp, schemeFollowUp, parseFollowUpQuery, followUpFilterLabels,
  type FollowUpFigures, type FollowUpPeriod,
} from "@/features/schemes/scheme-follow-up.server";

/**
 * Follow-up download — reuses the app's ONE export mechanism (server-side ExcelJS via `buildReportXlsx`,
 * returned as an attachment) exactly like /api/reports/export, so the file format and header layout match
 * every other download in the product. Read-only: it re-runs the same scoped read the screen used.
 *
 * `type`, `kind`, `drillChild` and `sort` are ReportPayload fields that only drive the Reports module's
 * drill-down UI; `buildReportXlsx` ignores them, so they carry no meaning here.
 */
function safeName(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
}

/** Blank rather than 0 for the period columns when All months / All weeks is selected. */
const cell = (n: number | null): number | string => (n == null ? "" : n);

const MONEY_COLUMNS = (period: FollowUpPeriod): ReportColumn[] => [
  { key: "schemeAmount", label: "Scheme Amount", format: "currency" },
  { key: "bookingAmount", label: "Booking Amount", format: "currency" },
  { key: "totalDue", label: "Total Due", format: "currency" },
  { key: "totalPaid", label: "Total Paid", format: "currency" },
  { key: "pending", label: "Pending", format: "currency" },
  { key: "pendingPct", label: "Pending %", format: "percent" },
  { key: "monthDue", label: `Month Due${period.month === "all" ? "" : ` (${period.monthLabel})`}`, format: "currency" },
  { key: "monthActual", label: "Month Actual", format: "currency" },
  { key: "weekDue", label: `Week Due${period.weekLabel ? ` (${period.weekLabel})` : ""}`, format: "currency" },
  { key: "weekActual", label: "Week Actual", format: "currency" },
  { key: "status", label: "Status", format: "text" },
];

const moneyCells = (f: FollowUpFigures): Record<string, string | number> => ({
  schemeAmount: f.schemeAmount,
  bookingAmount: f.bookingAmount,
  totalDue: f.totalDue,
  totalPaid: f.totalPaid,
  pending: f.pending,
  pendingPct: cell(f.pendingPct),
  monthDue: cell(f.monthDue),
  monthActual: cell(f.monthActual),
  weekDue: cell(f.weekDue),
  weekActual: cell(f.weekActual),
  status: f.status,
});

const totalsOf = (f: FollowUpFigures): Record<string, number> => ({
  schemeAmount: f.schemeAmount, bookingAmount: f.bookingAmount, totalDue: f.totalDue,
  totalPaid: f.totalPaid, pending: f.pending, ...(f.pendingPct == null ? {} : { pendingPct: f.pendingPct }),
  ...(f.monthDue == null ? {} : { monthDue: f.monthDue, monthActual: f.monthActual ?? 0 }),
  ...(f.weekDue == null ? {} : { weekDue: f.weekDue, weekActual: f.weekActual ?? 0 }),
});

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth();
    const q = parseFollowUpQuery(req.nextUrl.searchParams);
    const view = req.nextUrl.searchParams.get("view") === "scheme" ? "scheme" : "dealer";

    let payload: ReportPayload;
    if (view === "scheme") {
      const data = await schemeFollowUp(ctx, q);
      const columns: ReportColumn[] = [
        { key: "schemeName", label: "Scheme", format: "text" },
        { key: "dealerCount", label: "Enrolled Dealers", format: "number" },
        ...MONEY_COLUMNS(data.period),
      ];
      const rows: ReportRow[] = data.rows.map((r) => ({ id: r.schemeId, schemeName: r.schemeName, dealerCount: r.dealerCount, ...moneyCells(r) }));
      payload = {
        type: "dealer", kind: "summary", title: "Scheme Follow-up", columns, rows,
        totals: totalsOf(data.totals), drillChild: null,
        meta: { seasonName: "", filters: followUpFilterLabels(data.period) }, sort: { key: "pending", dir: "desc" },
      };
    } else {
      const data = await dealerFollowUp(ctx, q);
      const columns: ReportColumn[] = [
        { key: "dealerName", label: "Dealer", format: "text" },
        { key: "town", label: "Town", format: "text" },
        { key: "salesOfficerName", label: "Sales Officer", format: "text" },
        { key: "schemeCount", label: "Schemes", format: "number" },
        ...MONEY_COLUMNS(data.period),
      ];
      const rows: ReportRow[] = data.rows.map((r) => ({
        id: r.dealerId, dealerName: r.dealerName, town: r.town ?? "—", salesOfficerName: r.salesOfficerName, schemeCount: r.schemeCount, ...moneyCells(r),
      }));
      payload = {
        type: "dealer", kind: "summary", title: "Dealer Follow-up", columns, rows,
        totals: totalsOf(data.totals), drillChild: null,
        meta: { seasonName: "", filters: followUpFilterLabels(data.period) }, sort: { key: "pending", dir: "desc" },
      };
    }

    const buffer = await buildReportXlsx(payload);
    const suffix = q.month === "all" ? "All_months" : `${q.month}${q.week === "all" ? "" : `_W${q.week}`}`;
    const filename = `${safeName(payload.title)}_${safeName(suffix)}.xlsx`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(error);
    return NextResponse.json({ error: "Failed to export follow-up" }, { status: 500 });
  }
}
