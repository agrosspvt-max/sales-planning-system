import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { listSeasonalMarketOptions } from "@/features/party-planning/seasonal.server";

// GET — the Markets the signed-in planner may choose for THIS Seasonal Plan (their Existing Markets + their approved Vacant Markets). The owner is the
// authenticated user; the plan must be theirs.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await listSeasonalMarketOptions(await requirePartyAuth(), id)); });
}
