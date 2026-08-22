import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { dealersForScheme } from "@/features/schemes/scheme-planning.server";

/** The caller's assigned dealers not yet planned into this scheme (Dealer dropdown for a new plan). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await dealersForScheme(await requireAuth(), (await ctx.params).id)));
}
