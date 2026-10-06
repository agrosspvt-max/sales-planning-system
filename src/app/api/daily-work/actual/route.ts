import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { enterDailyActual, enterAppointmentStatus, enterConversionAchievability, enterVisitsActual, assertDailyWorkSectionWritable } from "@/features/daily-work/service.server";
import { resolveReportDate } from "@/lib/daily-work";

// POST /api/daily-work/actual — exact frozen-entry actual/result update, dispatched by section.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    // Report writes may target yesterday while its noon deadline is open (the service rejects anything later).
    const raw = await req.json();
    const body = { ...raw, workDate: resolveReportDate(raw?.workDate) };
    if (body?.section === "APPOINTMENT") return ok(await enterAppointmentStatus(auth, body));
    if (body?.section === "SCHEME_CONVERSION") { assertDailyWorkSectionWritable(body.section); return ok(await enterConversionAchievability(auth, body)); }
    if (body?.section === "VISITS") return ok(await enterVisitsActual(auth, body));
    return ok(await enterDailyActual(auth, body));
  });
}
