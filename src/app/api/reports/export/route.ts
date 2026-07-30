import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, ApiError } from "@/lib/http";
import { getReport } from "@/features/reports/service.server";
import { buildReportXlsx } from "@/lib/export/report-xlsx";
import { parseReportParams } from "@/features/reports/params";

function safeName(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth();
    const { seasonId, type, filters, sort } = parseReportParams(req.nextUrl.searchParams);
    const payload = await getReport(ctx, seasonId, type, { filters, sort });
    const buffer = await buildReportXlsx(payload);
    const filename = `${safeName(payload.title)}_${safeName(payload.meta.seasonName)}.xlsx`;

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
    return NextResponse.json({ error: "Failed to export report" }, { status: 500 });
  }
}
