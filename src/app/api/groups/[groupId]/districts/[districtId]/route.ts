import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { setDistrictActive } from "@/features/users/district-master.server";

// PATCH { isActive } — activate / deactivate one district of this state.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ groupId: string; districtId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId, districtId } = await ctx.params;
    return ok(await setDistrictActive(auth, groupId, districtId, await req.json()));
  });
}
