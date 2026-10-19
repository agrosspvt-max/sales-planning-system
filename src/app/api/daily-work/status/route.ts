import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getDailyStatus, resolveReportDateForOwner } from "@/features/daily-work/service.server";

// GET /api/daily-work/status — the completion state of today (or, for the report, yesterday via ?date=) + submit gate.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await getDailyStatus(auth, await resolveReportDateForOwner(auth, req.nextUrl.searchParams.get("date"))));
  });
}
