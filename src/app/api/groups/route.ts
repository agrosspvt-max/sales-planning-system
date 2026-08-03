import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listGroups, createGroup } from "@/features/users/groups.server";

export async function GET(_req: NextRequest) {
  return handle(async () => ok(await listGroups(await requireAuth())));
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await createGroup(auth, await req.json()));
  });
}
