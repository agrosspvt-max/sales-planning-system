import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { extendConversionDate } from "@/features/schemes/scheme-planning.server";

/** Extend a dealer plan's planned Conversion Date. Owner Sales Officer / RM only; all limits enforced server-side. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await extendConversionDate(await requireAuth(), (await ctx.params).id, await req.json())));
}
