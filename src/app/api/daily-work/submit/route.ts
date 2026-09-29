import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { submitDailyWork, submitDailyAppointment, submitDailyConversion, submitDailySummary } from "@/features/daily-work/service.server";
import { currentBusinessDate } from "@/lib/daily-work";

// Legacy per-section endpoint. The service directs callers to the atomic Submit Daily Work batch action.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const body = { ...await req.json(), workDate: currentBusinessDate() };
    if (body?.section === "APPOINTMENT") return ok(await submitDailyAppointment(auth, body));
    if (body?.section === "SCHEME_CONVERSION") return ok(await submitDailyConversion(auth, body));
    if (body?.section === "SUMMARY") return ok(await submitDailySummary(auth, body));
    return ok(await submitDailyWork(auth, body));
  });
}
