import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateInstanceBillingDate } from "@/features/schemes/scheme-enrolled.server";

/** Update ONE enrolled instance's billing date (recomputes only that instance's installment dates). */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await updateInstanceBillingDate(await requireAuth(), (await ctx.params).id, await req.json())));
}
