import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getLastPaymentReport, getLastPaymentReportOptions } from "@/features/reports/last-payment-report.server";
import { parseLastPaymentReportParams } from "@/lib/last-payment-report";

// Read-only. Scope comes from the session; the only accepted parameters are search / sort / page / pageSize / the column filters /
// Payment Aging. `optionsOnly=1` returns just the cascading dropdown options for a set of (pending) selections — no table rows.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const params = parseLastPaymentReportParams(req.nextUrl.searchParams);
    if (req.nextUrl.searchParams.get("optionsOnly") === "1") return ok(await getLastPaymentReportOptions(ctx, params.filters));
    return ok(await getLastPaymentReport(ctx, params));
  });
}
