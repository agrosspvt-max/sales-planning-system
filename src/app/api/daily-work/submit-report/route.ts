import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { submitDailyReport } from "@/features/daily-work/service.server";
import { resolveReportDate } from "@/lib/daily-work";

// POST /api/daily-work/submit-report — final once-per-day report submission + Self Rating (today, or yesterday until its 12:00 PM deadline).
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const raw = await req.json();
    return ok(await submitDailyReport(auth, { ...raw, workDate: resolveReportDate(raw?.workDate) }));
  });
}
