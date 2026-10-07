import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { parsePageParams } from "@/lib/pagination";
import { listTerritoryDealers } from "@/features/party-planning/territory.server";

// GET /api/territory-mapping/dealers?search=&market=&page=&pageSize= — every dealer in the caller's server-side scope.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const params = parsePageParams(req.nextUrl.searchParams);
    return ok(await listTerritoryDealers(ctx, { ...params, market: req.nextUrl.searchParams.get("market") ?? "" }));
  });
}
