import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { getChildRestoreContext, type ChildKind } from "@/features/planning/lifecycle.server";

/** Detect whether restoring a Monthly/Recovery plan needs its archived parent handled. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const kind = req.nextUrl.searchParams.get("kind");
    const id = req.nextUrl.searchParams.get("id");
    if ((kind !== "MONTHLY" && kind !== "RECOVERY") || !id) throw new ApiError(422, "kind (MONTHLY|RECOVERY) and id are required");
    return ok(await getChildRestoreContext(auth, kind as ChildKind, id));
  });
}
