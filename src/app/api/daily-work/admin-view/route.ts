import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getAdminDailyWorkView } from "@/features/daily-work/service.server";

// GET /api/daily-work/admin-view?date=&groupId=&officerId= — Admin-only, submitted Daily Report read.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const p = req.nextUrl.searchParams;
    return ok(await getAdminDailyWorkView(auth, {
      workDate: p.get("date") ?? "",
      groupId: p.get("groupId") ?? "",
      officerId: p.get("officerId") ?? "",
    }));
  });
}
