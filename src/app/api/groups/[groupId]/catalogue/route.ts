import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listGroupCatalogue, addCatalogueProduct } from "@/features/users/catalogue.server";

/** The group's product catalogue (rows + summary + addable Master products). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    return ok(await listGroupCatalogue(auth, groupId));
  });
}

/** Add an existing Master product to this group's catalogue. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    return ok(await addCatalogueProduct(auth, groupId, await req.json()), 201);
  });
}
