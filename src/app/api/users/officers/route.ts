import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listOfficers, type UserFilter } from "@/features/users/service.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const filter = (req.nextUrl.searchParams.get("filter") ?? "active") as UserFilter;
    const groupId = req.nextUrl.searchParams.get("groupId") ?? undefined;
    return ok(await listOfficers(auth, filter, groupId));
  });
}
