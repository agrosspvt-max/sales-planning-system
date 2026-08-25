import { NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getSchemeDeletionImpact } from "@/features/schemes/scheme-master.server";

// Real, DB-computed counts of the records a permanent delete would remove (Super-Admin only).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await getSchemeDeletionImpact(await requireAuth(), (await ctx.params).id)));
}
