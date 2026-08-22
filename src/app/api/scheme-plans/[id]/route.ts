import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getSchemePlan } from "@/features/schemes/scheme-planning.server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await getSchemePlan(await requireAuth(), (await ctx.params).id)));
}
