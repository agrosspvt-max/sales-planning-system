import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { planningContext } from "@/features/schemes/scheme-planning.server";

/** Scheme info + the caller's assigned dealers + any saved plans (draft re-open) for the planning page. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await planningContext(await requireAuth(), (await ctx.params).id)));
}
