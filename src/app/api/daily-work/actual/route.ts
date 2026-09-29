import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { enterDailyActual, enterAppointmentStatus, enterConversionAchievability, enterVisitsActual } from "@/features/daily-work/service.server";
import { currentBusinessDate } from "@/lib/daily-work";

// POST /api/daily-work/actual — exact frozen-entry actual/result update, dispatched by section.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const body = { ...await req.json(), workDate: currentBusinessDate() };
    if (body?.section === "APPOINTMENT") return ok(await enterAppointmentStatus(auth, body));
    if (body?.section === "SCHEME_CONVERSION") return ok(await enterConversionAchievability(auth, body));
    if (body?.section === "VISITS") return ok(await enterVisitsActual(auth, body));
    return ok(await enterDailyActual(auth, body));
  });
}
