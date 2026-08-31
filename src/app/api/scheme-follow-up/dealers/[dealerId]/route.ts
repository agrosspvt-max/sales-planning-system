import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { dealerFollowUpDetail, parseFollowUpQuery } from "@/features/schemes/scheme-follow-up.server";

/**
 * DEALER DRILL-DOWN — dealer info, summary, scheme-wise breakdown and payment report for ONE dealer at
 * the selected snapshot. Read-only. A dealer outside the caller's scope returns 404 (never a partial
 * payload), so an id cannot be probed for existence.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ dealerId: string }> }) {
  return handle(async () =>
    ok(await dealerFollowUpDetail(await requireAuth(), (await ctx.params).dealerId, parseFollowUpQuery(req.nextUrl.searchParams))),
  );
}
