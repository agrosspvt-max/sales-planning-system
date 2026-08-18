import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { initializeFromMaster } from "@/features/users/catalogue.server";

/** Initialize (or top-up) the group's catalogue from all active Master products. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    return ok(await initializeFromMaster(auth, groupId));
  });
}
