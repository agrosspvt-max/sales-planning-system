import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { readGroupPlanFilter } from "@/features/planning/group-plan-query.server";
import { getDealerSalesBills } from "@/features/planning/dealer-sales-bills.server";

export async function GET(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    const q = req.nextUrl.searchParams;
    const seasonId = q.get("seasonId"),
      dealerId = q.get("dealerId");
    if (!seasonId || !dealerId) throw new ApiError(422, "seasonId and dealerId are required");
    return ok(await getDealerSalesBills(auth, groupId, seasonId, dealerId, readGroupPlanFilter(q)));
  });
}
