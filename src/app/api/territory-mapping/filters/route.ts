import { handle, ok, requireAuth } from "@/lib/http";
import { listTerritoryFilterOptions } from "@/features/party-planning/territory.server";

// GET — the Sales Officer / State filter choices for the caller's role (SO none, RM own team, Admin all).
export async function GET() {
  return handle(async () => ok(await listTerritoryFilterOptions(await requireAuth())));
}
