import { type NextRequest } from "next/server";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { createSeasonalSheet, listSeasonalSheets } from "@/features/party-planning/seasonal.server";

// GET ?season=<id>&needsReview=1 — the Seasonal Plans the caller may see, across all seasons (scope applied in the service).
// POST { seasonId } — create the caller's Seasonal Plan for a CHOSEN open season.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePartyAuth();
    const q = req.nextUrl.searchParams;
    return ok(await listSeasonalSheets(ctx, { seasonId: q.get("season") || undefined, needsReview: q.get("needsReview") === "1" }));
  });
}
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createSeasonalSheet(await requirePartyAuth(), await req.json())));
}
