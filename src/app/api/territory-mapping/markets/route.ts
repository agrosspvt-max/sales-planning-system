import { handle, ok, requireAuth } from "@/lib/http";
import { listMarkets } from "@/features/party-planning/territory.server";

// GET /api/territory-mapping/markets — the Market master (approved / usable Markets only).
export async function GET() {
  return handle(async () => ok(await listMarkets(await requireAuth())));
}
