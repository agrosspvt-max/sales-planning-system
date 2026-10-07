import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createMarketRequest, listMarketRequests, type MarketRequestView } from "@/features/party-planning/territory.server";

// GET ?view=mine|review|history · POST { marketName, potential, numberOfParties }
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const raw = req.nextUrl.searchParams.get("view");
    const view: MarketRequestView = raw === "review" || raw === "history" ? raw : "mine";
    return ok(await listMarketRequests(ctx, view));
  });
}
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createMarketRequest(await requireAuth(), await req.json())));
}
