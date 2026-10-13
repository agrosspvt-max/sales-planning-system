import { handle, ok, requireAuth } from "@/lib/http";
import { rescheduleBillingTask } from "@/features/daily-work/billing-task.server";

// POST { taskDate } — the responsible officer moves the task to today or a later day; only this task's own contribution is reversed and re-applied.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; const body = (await req.json().catch(() => ({}))) as { taskDate?: unknown }; return ok(await rescheduleBillingTask(await requireAuth(), id, body.taskDate)); });
}
