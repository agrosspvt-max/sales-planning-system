import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getWorkbook } from "@/features/planning/service.server";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const dealerId = req.nextUrl.searchParams.get("dealerId") ?? undefined;
    return ok(await getWorkbook(auth, id, dealerId));
  });
}
