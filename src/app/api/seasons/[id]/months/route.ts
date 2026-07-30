import { type NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/http";
import { getSeasonMonthStates } from "@/features/planning/planning-state.server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requirePermission("seasons", "read");
    const { id } = await ctx.params;
    return ok(await getSeasonMonthStates(id));
  });
}
