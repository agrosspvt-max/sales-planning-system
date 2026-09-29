import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { setDailyWorkAttendance } from "@/features/daily-work/service.server";

// POST /api/daily-work/attendance — Super-Admin-only. Sets one officer/date attendance override { officerId, workDate, status }.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await setDailyWorkAttendance(auth, await req.json()));
  });
}
