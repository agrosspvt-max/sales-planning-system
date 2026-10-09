import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { appointRow } from "@/features/party-planning/monthly.server";

// POST { dealer: { name, aliasName, officerId, groupId, town?, addToSeasonalPlan?, force? }, remarks? } — Admin only: creates the Dealer (same service as Dealer Alias →
// Create Dealer) and marks the row Appointed in ONE transaction. Returns { duplicates } (nothing saved) when a similar dealer exists and force is not set.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await appointRow(await requireAuth(), id, await req.json())); });
}
