import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listTagDealers } from "@/features/dealer-tags/service.server";
// Optional ?officerIds=a,b narrows to dealers currently owned by any of those officers. Scope is enforced server-side
// first, so ids outside the caller's scope match nothing.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const officerIds = (req.nextUrl.searchParams.get("officerIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    return ok(await listTagDealers(await requireAuth(), { officerIds }));
  });
}
