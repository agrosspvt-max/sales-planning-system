import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateCatalogueEntry } from "@/features/users/catalogue.server";

/** Update one catalogue entry (group price and/or active status). */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ groupId: string; productId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId, productId } = await ctx.params;
    return ok(await updateCatalogueEntry(auth, groupId, productId, await req.json()));
  });
}
