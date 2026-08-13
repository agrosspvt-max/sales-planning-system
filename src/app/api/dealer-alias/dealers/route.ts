import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listDealersForAlias, type DealerAliasFilter } from "@/features/sales-upload/alias.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const q = req.nextUrl.searchParams;
    const filter = (q.get("filter") ?? "all") as DealerAliasFilter;
    const groupId = q.get("group") || undefined;
    const officerId = q.get("officer") || undefined;
    return ok(await listDealersForAlias(auth, filter, groupId, officerId));
  });
}
