import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getCnRequest } from "@/features/cn-requests/service.server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await getCnRequest(auth, id));
  });
}
