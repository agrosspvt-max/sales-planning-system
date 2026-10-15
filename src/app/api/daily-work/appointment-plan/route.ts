import { type NextRequest } from "next/server";
import { handle, ok, ApiError } from "@/lib/http";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { getOwnPlanDto } from "@/features/party-planning/monthly.server";

import { getAppointmentPartyPlanningEnabled } from "@/lib/recovery-config";
import { getResolvedLabels } from "@/features/labels/service.server";

// GET /api/daily-work/appointment-plan?id= — the caller's OWN Monthly Party Planning entry, as the (shared) status dialog needs it. Anyone else's entry is "not found".
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePartyAuth();
    if (!(await getAppointmentPartyPlanningEnabled())) throw new ApiError(409, (await getResolvedLabels())["daily_work.validation.appointment_connection_disabled"]);
    return ok(await getOwnPlanDto(ctx, req.nextUrl.searchParams.get("id") ?? ""));
  });
}
