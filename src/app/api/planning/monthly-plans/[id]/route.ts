import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getMonthlyPlan, saveMonthlyPlanEntries } from "@/features/planning/monthly-plan.server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await getMonthlyPlan(auth, id));
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await saveMonthlyPlanEntries(auth, id, await req.json()));
  });
}
