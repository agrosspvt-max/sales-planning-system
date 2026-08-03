import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { changeOwnPassword } from "@/features/users/service.server";

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await changeOwnPassword(auth, await req.json()));
  });
}
