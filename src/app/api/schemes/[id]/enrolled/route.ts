import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { enrolledSchemeDetail } from "@/features/schemes/scheme-enrolled.server";

/** Enrolled dealers + installment schedules for one scheme (Enrolled Scheme detail). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await enrolledSchemeDetail(await requireAuth(), (await ctx.params).id)));
}
