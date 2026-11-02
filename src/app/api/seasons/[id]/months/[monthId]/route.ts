import { type NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/http";
import { getRemoveMonthOptions, removeSeasonMonth } from "@/features/seasons/remove-month.server";

export const maxDuration = 120; // covers the bounded transfer transaction and connection wait

type Context = { params: Promise<{ id: string; monthId: string }> };
export async function GET(_req: NextRequest, ctx: Context) {
  return handle(async () => {
    const auth = await requirePermission("seasons", "update");
    const { id, monthId } = await ctx.params;
    return ok(await getRemoveMonthOptions(auth, id, monthId));
  });
}
export async function DELETE(req: NextRequest, ctx: Context) {
  return handle(async () => {
    const auth = await requirePermission("seasons", "update");
    const { id, monthId } = await ctx.params;
    return ok(await removeSeasonMonth(auth, id, monthId, await req.json()));
  });
}
