import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getAdminPerformance } from "@/features/daily-work/service.server";

// GET /api/daily-work/admin-performance?date=&rmId=&groupId=&submission= — Admin company-wide performance.
// Super-Admin-only (enforced in the service); filters are validated server-side against the authoritative set.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const p = req.nextUrl.searchParams;
    return ok(await getAdminPerformance(auth, {
      date: p.get("date") ?? undefined,
      rmId: p.get("rmId") ?? undefined,
      groupId: p.get("groupId") ?? undefined,
      submission: p.get("submission") ?? undefined,
    }));
  });
}
