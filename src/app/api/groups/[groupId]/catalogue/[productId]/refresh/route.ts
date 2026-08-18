import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { refreshPriceImpact, applyPriceRefresh } from "@/features/users/catalogue.server";

/** Price Update Impact — counts of plans by status (Approved grouped by season). Changes nothing. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ groupId: string; productId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId, productId } = await ctx.params;
    return ok(await refreshPriceImpact(auth, groupId, productId));
  });
}

/** Apply the current group price to the selected plan sets (draft/submitted/approved+seasons). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ groupId: string; productId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId, productId } = await ctx.params;
    return ok(await applyPriceRefresh(auth, groupId, productId, await req.json()));
  });
}
