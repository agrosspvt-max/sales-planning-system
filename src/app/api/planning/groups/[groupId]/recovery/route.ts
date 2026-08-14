import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { getGroupRecovery } from "@/features/planning/group-recovery.server";
import { ALL_BUCKETS, type StatusBucket } from "@/features/planning/group-plan.server";

/**
 * Read-only Territory (Group) Recovery aggregated across every officer's recovery plan for one month.
 * Query params: seasonId (required), month = seasonMonthId (required), buckets = comma approved|submitted|draft.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    const q = req.nextUrl.searchParams;
    const seasonId = q.get("seasonId");
    if (!seasonId) throw new ApiError(422, "seasonId is required");
    // `month` is optional and empty-tolerant (matches the Territory Product Plan contract): an empty
    // string means "no month chosen yet" and getGroupRecovery resolves it to the season's first month.
    const seasonMonthId = q.get("month") ?? "";
    const buckets = (q.get("buckets") ?? "approved")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is StatusBucket => (ALL_BUCKETS as string[]).includes(s));
    const officerId = q.get("officerId")?.trim() || undefined;
    return ok(await getGroupRecovery(auth, groupId, seasonId, seasonMonthId, buckets.length ? buckets : ["approved"], officerId));
  });
}
