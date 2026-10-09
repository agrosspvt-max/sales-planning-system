import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { editDealerMarket } from "@/features/party-planning/territory.server";

// POST /api/territory-mapping/dealers/:dealerId/market — { expectedMarket, market }: temporary manual Market edit (with history). Scope re-checked in the service.
export async function POST(req: NextRequest, { params }: { params: Promise<{ dealerId: string }> }) {
  return handle(async () => {
    const ctx = await requireAuth();
    const { dealerId } = await params;
    return ok(await editDealerMarket(ctx, dealerId, await req.json()));
  });
}
