import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { editDealer, deleteDealer } from "@/features/dealers/manage.server";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await editDealer(auth, id, await req.json()));
  });
}

/** Soft delete (never hard delete). */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await deleteDealer(auth, id));
  });
}
