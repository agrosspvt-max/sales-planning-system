import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listOfficerDealers, type DealerFilter } from "@/features/dealers/manage.server";

export async function GET(req: NextRequest, ctx: { params: Promise<{ officerId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { officerId } = await ctx.params;
    const filter = (req.nextUrl.searchParams.get("filter") ?? "active") as DealerFilter;
    return ok(await listOfficerDealers(auth, officerId, filter));
  });
}
