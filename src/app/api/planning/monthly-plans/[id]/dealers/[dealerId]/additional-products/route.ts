import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { getAdditionalProductCandidates, addAdditionalProduct } from "@/features/planning/monthly-plan.server";

/** Candidate products (active, not yet on this dealer) that can be added as Additional Products. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; dealerId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id, dealerId } = await ctx.params;
    return ok(await getAdditionalProductCandidates(auth, id, dealerId));
  });
}

const schema = z.object({ productId: z.string().min(1) });

/** Add an Additional Product line (isAdditional) so it can be planned this month. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; dealerId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id, dealerId } = await ctx.params;
    const { productId } = schema.parse(await req.json());
    return ok(await addAdditionalProduct(auth, id, dealerId, productId));
  });
}
