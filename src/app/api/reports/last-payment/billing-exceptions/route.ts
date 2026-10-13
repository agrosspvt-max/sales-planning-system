import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createBillingException, listBillingExceptionOptions, listBillingExceptions } from "@/features/reports/billing-exception.server";
import { parseExceptionView } from "@/lib/billing-exception";
import { parseLastPaymentReportParams } from "@/lib/last-payment-report";

// GET ?view=current|history — one row per exception, scoped by the session (no officer / scope parameter is read). `optionsOnly=1` returns just the
// cascading dropdown options for pending filter selections.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const sp = req.nextUrl.searchParams;
    const view = parseExceptionView(sp.get("view"));
    const params = parseLastPaymentReportParams(sp);
    if (sp.get("optionsOnly") === "1") return ok(await listBillingExceptionOptions(ctx, view, params.filters));
    return ok(await listBillingExceptions(ctx, view, params));
  });
}

// POST { dealerId, billingDate, billNo, authPerson, requestId } — create one exception. Days / payment snapshot / lifecycle / owner are server-derived.
export async function POST(req: Request) {
  return handle(async () => {
    const ctx = await requireAuth();
    const created = await createBillingException(ctx, await req.json().catch(() => ({})));
    return ok(created, created.duplicate ? 200 : 201);
  });
}
