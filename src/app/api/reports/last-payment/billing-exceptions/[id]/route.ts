import { handle, ok, requireAuth } from "@/lib/http";
import { getBillingExceptionDetail } from "@/features/reports/billing-exception.server";

// GET — the details of ONE exception (current or resolved), if its dealer is in the caller's scope.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await getBillingExceptionDetail(await requireAuth(), id)); });
}
