import { handle, ok, requireAuth } from "@/lib/http";
import { rescheduleBillingTask } from "@/features/daily-work/billing-task.server";

// POST { taskDate } — the responsible Sales Officer (or their Regional Manager) moves the task to a day AFTER today; the same task row moves, only its own contribution leaves today's plan.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; const body = (await req.json().catch(() => ({}))) as { taskDate?: unknown }; return ok(await rescheduleBillingTask(await requireAuth(), id, body.taskDate)); });
}
