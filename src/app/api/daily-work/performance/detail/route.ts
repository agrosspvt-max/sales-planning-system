import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getPerformanceMetricDetail } from "@/features/daily-work/service.server";

// GET /api/daily-work/performance/detail?metric=&from=&to=&officerId=&groupId=&page=&pageSize=&sort=&dir= — the records behind one
// Performance summary card. Same role scope and filters as /api/daily-work/performance (enforced in the service).
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const p = req.nextUrl.searchParams;
    return ok(await getPerformanceMetricDetail(auth, Object.fromEntries(["metric", "from", "to", "officerId", "groupId", "page", "pageSize", "sort", "dir"].flatMap((k) => (p.get(k) != null ? [[k, p.get(k)!]] : [])))));
  });
}
