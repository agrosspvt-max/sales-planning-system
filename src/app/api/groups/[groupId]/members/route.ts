import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { addOfficersToGroup } from "@/features/users/groups.server";

/** Add officers to the group. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    return ok(await addOfficersToGroup(auth, groupId, await req.json()));
  });
}
