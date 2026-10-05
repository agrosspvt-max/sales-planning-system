import { handle, ok, requireAuth } from "@/lib/http";
import { listTagSalesOfficers } from "@/features/dealer-tags/service.server";
export async function GET() {
  return handle(async () => ok(await listTagSalesOfficers(await requireAuth())));
}
