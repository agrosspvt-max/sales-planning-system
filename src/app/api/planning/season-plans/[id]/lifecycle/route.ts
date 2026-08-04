import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { setSeasonalPlanLifecycle, deleteSeasonalPlan } from "@/features/planning/lifecycle.server";

const bodySchema = z.object({ action: z.enum(["close", "reopen", "deactivate", "reactivate"]) });

/** Close / reopen / deactivate / reactivate a Seasonal plan (Super Admin). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const { action } = bodySchema.parse(await req.json());
    return ok(await setSeasonalPlanLifecycle(auth, id, action));
  });
}

/** Hard-delete a Draft/Returned/Rejected Seasonal plan (Super Admin). Approved must be deactivated. */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await deleteSeasonalPlan(auth, id));
  });
}
