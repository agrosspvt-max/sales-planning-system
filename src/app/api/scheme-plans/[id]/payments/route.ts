import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { addSchemePayment } from "@/features/schemes/scheme-payments.server";

/** Record a payment against an enrolled dealer plan and allocate it sequentially (Super Admin only). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await addSchemePayment(await requireAuth(), (await ctx.params).id, await req.json()), 201));
}
