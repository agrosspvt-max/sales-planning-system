import { type NextRequest } from "next/server";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { getSeasonalSheet } from "@/features/party-planning/seasonal.server";

// GET ?search=&stage=create|submitted|approved|older — ONE Seasonal Plan by id: its season, its rows (scope + draft privacy applied in the service).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await getSeasonalSheet(await requirePartyAuth(), id, req.nextUrl.searchParams.get("search") ?? "", req.nextUrl.searchParams.get("stage") ?? undefined)); });
}
