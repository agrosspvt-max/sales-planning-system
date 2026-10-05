import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { saveDailyWork, saveDailyAppointment, saveDailyConversion, saveDailySummary, assertDailyWorkSectionWritable } from "@/features/daily-work/service.server";
import { currentBusinessDate } from "@/lib/daily-work";

// POST /api/daily-work/save — persist the caller's daily rows for one section+date as DRAFT (atomic).
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const body = { ...await req.json(), workDate: currentBusinessDate() };
    if (body?.section === "APPOINTMENT") return ok(await saveDailyAppointment(auth, body));
    if (body?.section === "SCHEME_CONVERSION") { assertDailyWorkSectionWritable(body.section); return ok(await saveDailyConversion(auth, body)); }
    if (body?.section === "SUMMARY") return ok(await saveDailySummary(auth, body));
    return ok(await saveDailyWork(auth, body));
  });
}
