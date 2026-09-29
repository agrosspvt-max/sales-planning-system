import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getTeamPerformance } from "@/features/daily-work/service.server";

// GET /api/daily-work/team?date=YYYY-MM-DD — RM Team Performance for a business date (defaults to today).
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await getTeamPerformance(auth, req.nextUrl.searchParams.get("date") ?? undefined));
  });
}
