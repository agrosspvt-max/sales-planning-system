import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createUser } from "@/features/users/service.server";

/** Create a Sales Officer or Regional Manager (Super Admin only). */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await createUser(auth, await req.json()));
  });
}
