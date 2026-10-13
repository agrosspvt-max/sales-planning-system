import { handle, ok, requireAuth } from "@/lib/http";
import { getBillingTaskDetail } from "@/features/daily-work/billing-task.server";

// GET — the originating Billing Exception behind a Daily Work task. The responsible officer (or an administrative viewer with Last Payment Report access); anyone else sees nothing.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await getBillingTaskDetail(await requireAuth(), id)); });
}
