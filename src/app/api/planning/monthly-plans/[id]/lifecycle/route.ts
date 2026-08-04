import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { setMonthlyPlanLifecycle, deleteMonthlyPlan } from "@/features/planning/lifecycle.server";

const bodySchema = z.object({ action: z.enum(["close", "reopen", "deactivate", "reactivate"]) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const { action } = bodySchema.parse(await req.json());
    return ok(await setMonthlyPlanLifecycle(auth, id, action));
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await deleteMonthlyPlan(auth, id));
  });
}
