import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { getGroupProductPlan } from "@/features/planning/group-plan.server";

/** Read-only Territory (Group) Product Plan aggregated across every officer's plans for a season. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    const seasonId = req.nextUrl.searchParams.get("seasonId");
    if (!seasonId) throw new ApiError(422, "seasonId is required");
    return ok(await getGroupProductPlan(auth, groupId, seasonId));
  });
}
