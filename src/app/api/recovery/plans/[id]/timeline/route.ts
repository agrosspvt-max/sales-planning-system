import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getRecoveryTimeline } from "@/features/recovery/service.server";

/** The aging-refresh timeline (every snapshot) for one recovery plan. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await getRecoveryTimeline(auth, id));
  });
}
