import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { returnPlan } from "@/features/planning/service.server";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await returnPlan(auth, id, await req.json()));
  });
}
