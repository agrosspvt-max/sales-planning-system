import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getPlanDetail, deleteSalesPlan } from "@/features/planning/service.server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await getPlanDetail(auth, id));
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await deleteSalesPlan(auth, id));
  });
}
