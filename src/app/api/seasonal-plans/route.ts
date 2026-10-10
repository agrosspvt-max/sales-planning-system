import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { createSeasonalPlan } from "@/features/party-planning/seasonal.server";

// POST { sheetId, marketId } — add a market row to the caller's Seasonal Plan. Owner, season and market data are server-derived.
export async function POST(req: Request) {
  return handle(async () => ok(await createSeasonalPlan(await requirePartyAuth(), await req.json())));
}
