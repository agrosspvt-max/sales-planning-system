import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { submitDailyReport } from "@/features/daily-work/service.server";
import { currentBusinessDate } from "@/lib/daily-work";

// POST /api/daily-work/submit-report — final once-per-business-day report submission + Self Rating.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await submitDailyReport(auth, { ...await req.json(), workDate: currentBusinessDate() }));
  });
}
