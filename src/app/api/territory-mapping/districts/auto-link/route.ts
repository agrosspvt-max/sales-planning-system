import { handle, ok, requireAuth } from "@/lib/http";
import { autoLinkTerritoryDistricts } from "@/features/party-planning/territory.server";

export async function POST() {
  return handle(async () => ok(await autoLinkTerritoryDistricts(await requireAuth())));
}
