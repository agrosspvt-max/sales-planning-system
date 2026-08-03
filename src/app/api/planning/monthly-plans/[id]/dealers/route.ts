import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createMonthlyDealer } from "@/features/planning/monthly-plan.server";

/** Create a new dealer directly from Monthly Planning (PENDING_APPROVAL until the plan approves). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await createMonthlyDealer(auth, id, await req.json()));
  });
}
