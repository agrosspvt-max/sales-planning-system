import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getDailyStatus } from "@/features/daily-work/service.server";
import { currentBusinessDate } from "@/lib/daily-work";

// GET /api/daily-work/status — the current India business day's completion state + submit gate.
export async function GET(_req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await getDailyStatus(auth, currentBusinessDate()));
  });
}
