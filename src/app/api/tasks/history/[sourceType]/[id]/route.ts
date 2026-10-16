import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { taskAnalysisScope } from "@/features/daily-work/service.server";
import { getTaskHistory } from "@/features/tasks/task-analysis.server";

// GET /api/tasks/history/<sourceType>/<taskId> — one task and its full, read-only rescheduling history (404 unless the task's employee is inside the caller's scope).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ sourceType: string; id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { sourceType, id } = await params;
    return ok(await getTaskHistory(await taskAnalysisScope(auth), sourceType, id));
  });
}
