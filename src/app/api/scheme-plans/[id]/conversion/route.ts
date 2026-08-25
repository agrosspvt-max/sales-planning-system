import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { saveConversion } from "@/features/schemes/scheme-planning.server";

/** Sales Officer sets Scheme Status + conversion entry on an Approved plan. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await saveConversion(await requireAuth(), (await ctx.params).id, await req.json())));
}
