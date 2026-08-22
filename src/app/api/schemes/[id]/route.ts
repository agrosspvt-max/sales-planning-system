import { NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getScheme, updateScheme } from "@/features/schemes/scheme-master.server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await getScheme(await requireAuth(), (await ctx.params).id)));
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await updateScheme(await requireAuth(), (await ctx.params).id, await req.json())));
}
