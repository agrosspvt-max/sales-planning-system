import { type NextRequest } from "next/server";
import { respondCnReview } from "@/features/cn-requests/cn-review.server";
import { handle, ok, requireAuth } from "@/lib/http";
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await respondCnReview(auth, id, await req.json()));
  });
}
