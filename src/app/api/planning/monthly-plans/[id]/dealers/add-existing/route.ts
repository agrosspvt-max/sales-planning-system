import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { addExistingDealerToMonthlyPlan } from "@/features/planning/monthly-plan.server";

/** Add an existing in-scope dealer to this monthly plan's season plan (scope enforced server-side). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const { dealerId } = (await req.json()) as { dealerId?: string };
    if (!dealerId) return ok({ added: false });
    return ok(await addExistingDealerToMonthlyPlan(auth, id, dealerId));
  });
}
