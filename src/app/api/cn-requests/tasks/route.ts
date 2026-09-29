import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listActiveCnTasks } from "@/features/cn-requests/service.server";
import { materializeDueDailyWorkTasks } from "@/features/daily-work/auto-task-materialization.server";

// GET /api/cn-requests/tasks — every active CN follow-up task assigned to the caller.
export async function GET(_req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    await materializeDueDailyWorkTasks(auth);
    return ok(await listActiveCnTasks(auth));
  });
}
