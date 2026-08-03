import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateMonthlyDealer } from "@/features/planning/monthly-plan.server";

/** Edit a PENDING dealer's info while the Monthly Plan is DRAFT/RETURNED (read-only after submit). */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; dealerId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id, dealerId } = await ctx.params;
    return ok(await updateMonthlyDealer(auth, id, dealerId, await req.json()));
  });
}
