import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { compareSnapshots } from "@/features/recovery/service.server";

/** Admin snapshot comparison: GET ?from=<snapshotId>&to=<snapshotId>. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const from = req.nextUrl.searchParams.get("from");
    const to = req.nextUrl.searchParams.get("to");
    if (!from || !to) throw new ApiError(422, "Both from and to snapshots are required");
    return ok(await compareSnapshots(auth, id, from, to));
  });
}
