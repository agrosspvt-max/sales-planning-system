import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { recallMonthlyPlan } from "@/features/planning/monthly-plan.server";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await recallMonthlyPlan(auth, id));
  });
}
