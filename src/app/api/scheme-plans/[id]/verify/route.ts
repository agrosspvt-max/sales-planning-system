import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { verifyScheme } from "@/features/schemes/scheme-planning.server";

/** Super Admin verification (three-column). Saves admin-final values; enrolls only when requested + eligible. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await verifyScheme(await requireAuth(), (await ctx.params).id, await req.json())));
}
