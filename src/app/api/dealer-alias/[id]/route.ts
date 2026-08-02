import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { deleteDealerAlias } from "@/features/sales-upload/alias.server";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await deleteDealerAlias(auth, id));
  });
}
