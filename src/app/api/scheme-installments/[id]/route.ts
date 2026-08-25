import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateInstallment } from "@/features/schemes/scheme-enrolled.server";

/** Update one installment. SO/RM: planned amount/date. Super Admin: also received amount/date. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await updateInstallment(await requireAuth(), (await ctx.params).id, await req.json())));
}
