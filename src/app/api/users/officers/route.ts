import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listOfficers, type UserFilter } from "@/features/users/service.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const filter = (req.nextUrl.searchParams.get("filter") ?? "active") as UserFilter;
    const groupId = req.nextUrl.searchParams.get("groupId") ?? undefined;
    // roles=all also lists Regional Managers (Users page). Default (omitted) = Sales Officers only,
    // so planning officer-selectors that reuse this endpoint are unaffected.
    const includeManagers = req.nextUrl.searchParams.get("roles") === "all";
    return ok(await listOfficers(auth, filter, groupId, includeManagers));
  });
}
