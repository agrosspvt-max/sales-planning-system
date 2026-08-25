import { NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getScheme, updateScheme, deleteScheme } from "@/features/schemes/scheme-master.server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await getScheme(await requireAuth(), (await ctx.params).id)));
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await updateScheme(await requireAuth(), (await ctx.params).id, await req.json())));
}
// Permanent, Super-Admin-only deletion of the scheme and all its scheme-owned records. The mandatory
// reason travels in the request body; authorization is enforced server-side inside deleteScheme.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const body = await req.json().catch(() => ({}));
    return ok(await deleteScheme(await requireAuth(), (await ctx.params).id, (body as { reason?: unknown }).reason));
  });
}
