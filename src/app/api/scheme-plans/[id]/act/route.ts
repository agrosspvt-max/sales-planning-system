import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { actOnSchemePlan } from "@/features/schemes/scheme-planning.server";

/** RM approve / reject / return a team member's submitted scheme plan (planning approval only). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await actOnSchemePlan(await requireAuth(), (await ctx.params).id, await req.json())));
}
