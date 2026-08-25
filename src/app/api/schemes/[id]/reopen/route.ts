import { NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { reopenScheme } from "@/features/schemes/scheme-master.server";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await reopenScheme(await requireAuth(), (await ctx.params).id)));
}
