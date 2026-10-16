import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { currentBusinessDate } from "@/lib/daily-work";
import { taskAnalysisScope } from "@/features/daily-work/service.server";
import { getTaskAnalysis, parseTaskFilters, taskLabels } from "@/features/tasks/task-analysis.server";

// GET /api/tasks/analysis — Performance → Tasks: summary + one page of tasks for the caller's authorized scope (SO self / RM team / Admin all) and the filters.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const p = Object.fromEntries(req.nextUrl.searchParams);
    const scope = await taskAnalysisScope(auth, { officerId: p.officerId, groupId: p.groupId });
    return ok(await getTaskAnalysis(scope, parseTaskFilters(p, currentBusinessDate(), await taskLabels())));
  });
}
