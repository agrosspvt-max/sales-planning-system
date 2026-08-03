import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { removeOfficerFromGroup } from "@/features/users/groups.server";

/** Remove an officer from the group → Unassigned. */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; officerId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { officerId } = await ctx.params;
    return ok(await removeOfficerFromGroup(auth, officerId));
  });
}
