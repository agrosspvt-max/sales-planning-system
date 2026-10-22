import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getDailyPerformance } from "@/features/daily-work/service.server";

// GET /api/daily-work/performance?from=&to=&officerId=&officerId=&groupId= — role-aware, date-range performance.
// Repeat officerId or groupId for multiple choices. Scope, columns and filters are decided server-side by the caller's role (SO / RM / Super Admin).
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const p = req.nextUrl.searchParams;
    return ok(await getDailyPerformance(auth, {
      from: p.get("from") ?? undefined,
      to: p.get("to") ?? undefined,
      officerIds: p.getAll("officerId"),
      groupIds: p.getAll("groupId"),
    }));
  });
}
