import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { enterTaskOutcomes, enterAppointmentStatus, enterConversionAchievability, enterVisitsActual, assertDailyWorkSectionWritable, resolveReportDateForOwner } from "@/features/daily-work/service.server";

export const maxDuration = 60; // seconds — not shorter than the transaction limit (DAILY_WORK_SAVE_TRANSACTION), on platforms that enforce a route limit

// POST /api/daily-work/actual — exact frozen-entry actual/result update, dispatched by section.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    // Report writes may target yesterday while its noon deadline is open (the service rejects anything later).
    const raw = await req.json();
    const body = { ...raw, workDate: await resolveReportDateForOwner(auth, raw?.workDate) };
    if (body?.section === "APPOINTMENT") return ok(await enterAppointmentStatus(auth, body));
    if (body?.section === "SCHEME_CONVERSION") { assertDailyWorkSectionWritable(body.section); return ok(await enterConversionAchievability(auth, body)); }
    if (body?.section === "VISITS") return ok(await enterVisitsActual(auth, body));
    // Sales / Recovery: a task OUTCOME per identifiable task (no direct Actual amount any more); nothing is committed until the report is submitted.
    return ok(await enterTaskOutcomes(auth, body));
  });
}
