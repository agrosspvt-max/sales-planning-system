import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getSeasonalSheet } from "@/features/party-planning/seasonal.server";

// GET ?search= — ONE Seasonal Plan by id: its season, its rows (scope + draft privacy applied in the service).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await getSeasonalSheet(await requireAuth(), id, req.nextUrl.searchParams.get("search") ?? "")); });
}
