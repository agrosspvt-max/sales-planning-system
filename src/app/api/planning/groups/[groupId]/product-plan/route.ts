import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { getGroupProductPlan, ALL_BUCKETS, type StatusBucket, type GroupPlanFilter } from "@/features/planning/group-plan.server";

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

    const buckets = (q.get("buckets") ?? "approved")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is StatusBucket => (ALL_BUCKETS as string[]).includes(s));
    const rawView = q.get("view") ?? "total";
    const view: GroupPlanFilter["view"] = rawView === "month" || rawView === "range" ? rawView : "total";
    const monthIds = (q.get("months") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const officerId = q.get("officerId")?.trim() || undefined;
    const seasonMetrics = q.get("seasonMetrics") === "filters" ? "filters" : "approved"; // default: Approved Baseline

    return ok(await getGroupProductPlan(auth, groupId, seasonId, { buckets: buckets.length ? buckets : ["approved"], view, monthIds, officerId, seasonMetrics }));
  });
}
