import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getLastPaymentReport } from "@/features/reports/last-payment-report.server";
import { parseLastPaymentReportParams } from "@/lib/last-payment-report";

// Read-only. Scope comes from the session; the only accepted parameters are search / sort / page / pageSize.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await getLastPaymentReport(ctx, parseLastPaymentReportParams(req.nextUrl.searchParams)));
  });
}
