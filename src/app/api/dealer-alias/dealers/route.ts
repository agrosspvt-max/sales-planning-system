import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listDealersForAlias, type DealerAliasFilter } from "@/features/sales-upload/alias.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const filter = (req.nextUrl.searchParams.get("filter") ?? "all") as DealerAliasFilter;
    return ok(await listDealersForAlias(auth, filter));
  });
}
