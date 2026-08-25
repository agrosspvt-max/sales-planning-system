import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { adminActOnSchemePlan } from "@/features/schemes/scheme-planning.server";

/** Super Admin approve / return / reject on planStatus (may override a plan still Pending for RM). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await adminActOnSchemePlan(await requireAuth(), (await ctx.params).id, await req.json())));
}
