import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listMarketEdits } from "@/features/party-planning/territory.server";

// GET /api/territory-mapping/dealers/:dealerId/market-history — every manual Market edit of the dealer, oldest first.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ dealerId: string }> }) {
  return handle(async () => {
    const ctx = await requireAuth();
    const { dealerId } = await params;
    return ok(await listMarketEdits(ctx, dealerId));
  });
}
