import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getOfficerPlans } from "@/features/profiles/plan-management.server";

/** All plans (Seasonal / Monthly / Recovery, every status & lifecycle) for one Sales Officer. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await getOfficerPlans(auth, id));
  });
}
