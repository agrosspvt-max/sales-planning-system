import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { toggleRecoveryWeekLock } from "@/features/recovery/service.server";

/** Admin-only: toggle the manual lock/unlock override for one business week of a recovery plan. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await toggleRecoveryWeekLock(auth, id, await req.json()));
  });
}
