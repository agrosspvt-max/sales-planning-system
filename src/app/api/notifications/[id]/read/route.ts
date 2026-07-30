import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { markRead } from "@/features/notifications/service.server";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    await markRead(auth, id);
    return ok({ success: true });
  });
}
