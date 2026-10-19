import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createMarketRequest, listMarketRequestsFiltered, type MarketRequestView } from "@/features/party-planning/territory.server";

// GET ?view=mine|review|history[&stateId=][&districtId=…][&requesterId=…] (repeatable) · POST { marketName, potential, numberOfParties }
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const raw = req.nextUrl.searchParams.get("view");
    const view: MarketRequestView = raw === "review" || raw === "history" ? raw : "mine";
    const q = req.nextUrl.searchParams;
    return ok(await listMarketRequestsFiltered(ctx, view, { stateId: q.get("stateId") ?? undefined, districtIds: q.getAll("districtId"), requesterIds: q.getAll("requesterId") }));
  });
}
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createMarketRequest(await requireAuth(), await req.json())));
}
