import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { getSeasonalOptions } from "@/features/party-planning/seasonal.server";

// GET — the OPEN seasons a Seasonal Plan can be created for.
export async function GET() {
  return handle(async () => ok(await getSeasonalOptions(await requirePartyAuth())));
}
