import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { enrolledSchemeDetail } from "@/features/schemes/scheme-enrolled.server";

/** Enrolled dealers + installment schedules for one scheme (Enrolled Scheme detail).
 *  `?officerId=` narrows an RM/Admin to one Sales Officer (server-validated). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const officerId = req.nextUrl.searchParams.get("officerId") ?? undefined;
  return handle(async () => ok(await enrolledSchemeDetail(await requireAuth(), (await ctx.params).id, officerId)));
}
