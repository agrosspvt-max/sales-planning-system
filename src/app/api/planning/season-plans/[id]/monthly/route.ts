import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getMonthly, saveMonthly } from "@/features/planning/monthly.server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await getMonthly(auth, id));
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await saveMonthly(auth, id, await req.json()));
  });
}
