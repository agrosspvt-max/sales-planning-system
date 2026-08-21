import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { myTeamOfficers } from "@/features/cn-requests/service.server";

/** The Sales Officers on the caller RM's team (options for the CN Request "Team" flow). RM only. */
export async function GET(_req: NextRequest) {
  return handle(async () => ok(await myTeamOfficers(await requireAuth())));
}
