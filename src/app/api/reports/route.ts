import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getReport } from "@/features/reports/service.server";
import { parseReportParams } from "@/features/reports/params";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const { seasonId, type, filters, sort } = parseReportParams(req.nextUrl.searchParams);
    return ok(await getReport(ctx, seasonId, type, { filters, sort }));
  });
}
