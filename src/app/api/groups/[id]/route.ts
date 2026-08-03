import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateGroup, deleteGroup } from "@/features/users/groups.server";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await updateGroup(auth, id, await req.json()));
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await deleteGroup(auth, id));
  });
}
