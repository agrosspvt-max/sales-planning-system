import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { submitSchemePlan } from "@/features/schemes/scheme-planning.server";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await submitSchemePlan(await requireAuth(), (await ctx.params).id)));
}
