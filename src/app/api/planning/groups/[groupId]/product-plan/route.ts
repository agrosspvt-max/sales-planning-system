import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { getGroupProductPlan } from "@/features/planning/group-plan.server";

import { readGroupPlanFilter } from "@/features/planning/group-plan-query.server";

/**
 * Read-only Territory (Group) Product Plan aggregated across every officer's plans for a season.
 * Query params:
 *   seasonId (required)
 *   buckets  = comma list of approved|submitted|draft (default "approved")
 *   view     = total | month | range (default total)
 *   months   = comma list of season-month ids (for view=month|range)
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    const q = req.nextUrl.searchParams;
    const seasonId = q.get("seasonId");
    if (!seasonId) throw new ApiError(422, "seasonId is required");

    return ok(await getGroupProductPlan(auth, groupId, seasonId, readGroupPlanFilter(q)));
  });
}
