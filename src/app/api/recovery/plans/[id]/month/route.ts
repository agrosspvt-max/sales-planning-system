import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { saveRecoveryMonth } from "@/features/recovery/service.server";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await saveRecoveryMonth(auth, id, await req.json()));
  });
}
