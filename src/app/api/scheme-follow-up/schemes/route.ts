import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { schemeFollowUp, parseFollowUpQuery } from "@/features/schemes/scheme-follow-up.server";

/**
 * SCHEME FOLLOW-UP list — the same recovery position aggregated per scheme, dealers nested for the
 * Collapsible View. Read-only; scoped server-side by `getOfficerScope`.
 */
export async function GET(req: NextRequest) {
  return handle(async () => ok(await schemeFollowUp(await requireAuth(), parseFollowUpQuery(req.nextUrl.searchParams))));
}
