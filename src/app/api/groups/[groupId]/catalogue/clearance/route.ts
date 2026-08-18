import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { setClearance, removeClearance } from "@/features/users/catalogue.server";

/** Mark products as clearance for this group (with optional clearance quantity). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    return ok(await setClearance(auth, groupId, await req.json()));
  });
}

/** Remove clearance from products in this group. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    return ok(await removeClearance(auth, groupId, await req.json()));
  });
}
