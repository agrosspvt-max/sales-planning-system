import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { confirmMaterializedAutoTask } from "@/features/cn-requests/service.server";

// POST /api/cn-requests/:id/confirm-task — the owning SO explicitly confirms a MATERIALIZED CN Auto Task for
// today's Daily Work. This never completes the payment task or changes its status/amount; it only records the
// explicit confirmation. Idempotent: confirming again returns the same confirmed state.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await confirmMaterializedAutoTask(auth, id, await req.json()));
  });
}
