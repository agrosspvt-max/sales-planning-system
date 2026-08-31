import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { paymentDealers, parsePaymentFilters } from "@/features/schemes/scheme-payments.server";

/** Enrolled dealer-plans with a payment summary + filter options (Payments page list). Scoped server-side. */
export async function GET(req: NextRequest) {
  return handle(async () => ok(await paymentDealers(await requireAuth(), parsePaymentFilters(req.nextUrl.searchParams))));
}
