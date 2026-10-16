import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { currentBusinessDate } from "@/lib/daily-work";
import { taskAnalysisScope } from "@/features/daily-work/service.server";
import { getRescheduleCalendar, parseTaskFilters, taskLabels } from "@/features/tasks/task-analysis.server";

// GET /api/tasks/reschedule-calendar?month=YYYY-MM&… — scheduled dates affected by rescheduling, for the SAME filtered population as the table (a focused date never narrows it).
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const L = await taskLabels();
    const p = Object.fromEntries(req.nextUrl.searchParams);
    const scope = await taskAnalysisScope(auth, { officerId: p.officerId, groupId: p.groupId });
    return ok(await getRescheduleCalendar(scope, parseTaskFilters(p, currentBusinessDate(), L), p.month ?? "", L));
  });
}
