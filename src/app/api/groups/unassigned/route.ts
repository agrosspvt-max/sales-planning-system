import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listUnassignedOfficers } from "@/features/users/groups.server";

export async function GET(_req: NextRequest) {
  return handle(async () => ok(await listUnassignedOfficers(await requireAuth())));
}
