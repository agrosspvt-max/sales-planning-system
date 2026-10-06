import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getDailyWorkReviewDetail, createDailyWorkReview } from "@/features/daily-work/service.server";

// GET /api/daily-work/review?officerId=&date= — read-only consolidated detail of a team member's submitted day (plan-only days included; rating needs the report).
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const p = req.nextUrl.searchParams;
    return ok(await getDailyWorkReviewDetail(auth, p.get("officerId") ?? "", p.get("date") ?? undefined, { allowPlanOnly: true }));
  });
}

// POST /api/daily-work/review — create the RM's single, immutable review { officerId, workDate, rating }.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await createDailyWorkReview(auth, await req.json()));
  });
}
