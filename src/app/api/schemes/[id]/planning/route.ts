import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { planningContext } from "@/features/schemes/scheme-planning.server";

/**
 * Scheme info + assigned dealers + any saved plans (draft re-open) for the planning page. `?officerId=`
 * lets an RM load a team Sales Officer's dealers ("My Team" flow); omitted → the caller's own dealers.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const officerId = req.nextUrl.searchParams.get("officerId") ?? undefined;
  return handle(async () => ok(await planningContext(await requireAuth(), (await ctx.params).id, officerId)));
}
