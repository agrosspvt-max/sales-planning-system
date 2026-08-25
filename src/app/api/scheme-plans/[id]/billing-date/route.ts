import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateBillingDate } from "@/features/schemes/scheme-enrolled.server";

/** Update an enrolled dealer's billing date (recomputes pending installment planned dates). */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await updateBillingDate(await requireAuth(), (await ctx.params).id, await req.json())));
}
