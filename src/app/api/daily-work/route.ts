import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getDailyWork, getDailyAppointment, getDailyConversion, getDailySummary } from "@/features/daily-work/service.server";
import { currentBusinessDate } from "@/lib/daily-work";

// GET /api/daily-work?section=SALES|RECOVERY|APPOINTMENT|SCHEME_CONVERSION|SUMMARY — current India business day.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const p = req.nextUrl.searchParams;
    const section = p.get("section") ?? "SALES";
    const view = p.get("view") ?? "PLAN";
    const date = currentBusinessDate();
    if (section === "APPOINTMENT") return ok(await getDailyAppointment(auth, date, undefined, view));
    if (section === "SCHEME_CONVERSION") return ok(await getDailyConversion(auth, date, undefined, view));
    if (section === "SUMMARY") return ok(await getDailySummary(auth, date, undefined, view));
    return ok(await getDailyWork(auth, section, date, undefined, view));
  });
}
