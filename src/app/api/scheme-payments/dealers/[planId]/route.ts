import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { dealerPaymentTimeline, parsePaymentFilters } from "@/features/schemes/scheme-payments.server";

/** One enrolled dealer-plan's full payment timeline + installment allocation history. Scoped server-side. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  return handle(async () => ok(await dealerPaymentTimeline(await requireAuth(), (await ctx.params).planId, parsePaymentFilters(req.nextUrl.searchParams))));
}
