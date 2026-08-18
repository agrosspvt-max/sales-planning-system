import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateProductMaster } from "@/features/users/catalogue.server";

/** Edit a product's Master info + Master price + per-group prices. Group prices write only to the
 *  Group Catalogue (never Product.rate for a group). */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ productId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { productId } = await ctx.params;
    return ok(await updateProductMaster(auth, productId, await req.json()));
  });
}
