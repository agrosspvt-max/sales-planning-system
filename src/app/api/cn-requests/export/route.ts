import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, ApiError } from "@/lib/http";
import { listCnRequestsForExport } from "@/features/cn-requests/service.server";
import { NO_CN_EXPORT_MESSAGE, cnExportFilename, isCnRequestView } from "@/lib/cn-request";
import { buildCnRequestsXlsx } from "@/lib/export/cn-requests-xlsx";

/**
 * CN Requests → Excel (Admin). GET ?view=submitted|rejected|accepted-not-posted|posted-in-ledger. The tab's own data path runs under the
 * caller's session scope and returns EVERY matching request (the table is not paginated); only Dealer / CN Type / Employee Name / State /
 * Territory are written. Read-only.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth();
    const view = req.nextUrl.searchParams.get("view");
    if (!isCnRequestView(view)) return NextResponse.json({ error: "Select a CN Requests tab to export." }, { status: 400 });
    const rows = await listCnRequestsForExport(ctx, view);
    if (rows.length === 0) return NextResponse.json({ error: NO_CN_EXPORT_MESSAGE }, { status: 422 });
    const filename = cnExportFilename(view);
    const buffer = await buildCnRequestsXlsx(rows, filename.replace(/^CN-Requests-|-\d{4}-\d{2}-\d{2}\.xlsx$/g, ""));
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "Failed to export CN Requests" }, { status: 500 });
  }
}
