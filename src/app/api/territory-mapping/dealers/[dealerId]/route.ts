import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateDealerMapping } from "@/features/party-planning/territory.server";

// PUT /api/territory-mapping/dealers/:dealerId — { marketId?, potential? }. Scope is re-checked in the service.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ dealerId: string }> }) {
  return handle(async () => {
    const ctx = await requireAuth();
    const { dealerId } = await params;
    return ok(await updateDealerMapping(ctx, dealerId, await req.json()));
  });
}
