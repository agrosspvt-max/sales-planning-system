import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { dealerFollowUp, parseFollowUpQuery } from "@/features/schemes/scheme-follow-up.server";

/**
 * DEALER FOLLOW-UP list — one row per dealer with the recovery position at the selected month/week
 * snapshot, schemes nested for the Collapsible View. Read-only; scoped server-side by `getOfficerScope`.
 */
export async function GET(req: NextRequest) {
  return handle(async () => ok(await dealerFollowUp(await requireAuth(), parseFollowUpQuery(req.nextUrl.searchParams))));
}
