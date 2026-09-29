import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { setDailyNoPlan } from "@/features/daily-work/service.server";
import { currentBusinessDate } from "@/lib/daily-work";

// POST /api/daily-work/no-plan — mark/unmark a mandatory section "No Plan" (rejected when the section has data).
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await setDailyNoPlan(auth, { ...await req.json(), workDate: currentBusinessDate() }));
  });
}
