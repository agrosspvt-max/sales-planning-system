import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createDealerForOfficer } from "@/features/planning/monthly-plan.server";

/** Admin creates a dealer for a Sales Officer (ACTIVE + assigned + aliased). Returns
 *  { duplicates } when a probable existing dealer is found and `force` was not set. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await createDealerForOfficer(auth, await req.json()));
  });
}
