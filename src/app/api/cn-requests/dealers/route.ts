import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { myAssignedDealers } from "@/features/cn-requests/service.server";

/**
 * Assigned dealers (Party options for a new CN Request). With `?officerId=`, an RM gets a team Sales
 * Officer's dealers (RM "Team" flow); otherwise the caller's own.
 */
export async function GET(req: NextRequest) {
  const officerId = req.nextUrl.searchParams.get("officerId") ?? undefined;
  return handle(async () => ok(await myAssignedDealers(await requireAuth(), officerId)));
}
