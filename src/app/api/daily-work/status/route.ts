import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getDailyStatus } from "@/features/daily-work/service.server";
import { resolveReportDate } from "@/lib/daily-work";

// GET /api/daily-work/status — the completion state of today (or, for the report, yesterday via ?date=) + submit gate.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await getDailyStatus(auth, resolveReportDate(req.nextUrl.searchParams.get("date"))));
  });
}
