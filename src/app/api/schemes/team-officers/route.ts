import { handle, ok, requireAuth } from "@/lib/http";
import { teamOfficers } from "@/features/schemes/scheme-planning.server";

/** Sales Officers on the caller RM's team (the "My Team" dealer-scope dropdown). RM only. */
export async function GET() {
  return handle(async () => ok(await teamOfficers(await requireAuth())));
}
