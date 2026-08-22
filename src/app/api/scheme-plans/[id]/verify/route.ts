import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { verifyEnrollment } from "@/features/schemes/scheme-planning.server";

/** Super Admin enrollment document verification → ENROLLED. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await verifyEnrollment(await requireAuth(), (await ctx.params).id, await req.json())));
}
