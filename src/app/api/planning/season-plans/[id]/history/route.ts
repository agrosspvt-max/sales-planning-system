import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getPlanHistory } from "@/features/planning/service.server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await getPlanHistory(auth, id));
  });
}
