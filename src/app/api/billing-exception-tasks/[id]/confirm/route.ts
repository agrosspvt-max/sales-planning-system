import { handle, ok, requireAuth } from "@/lib/http";
import { confirmBillingTask } from "@/features/daily-work/billing-task.server";

// POST — the responsible officer confirms the task for today's Daily Work (never completes it, never changes the amount). Idempotent.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await confirmBillingTask(await requireAuth(), id)); });
}
