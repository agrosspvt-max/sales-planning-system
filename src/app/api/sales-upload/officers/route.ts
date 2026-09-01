import { handle, ok, requireAuth } from "@/lib/http";
import { listSalesOfficers } from "@/features/sales-upload/service.server";

/** Existing active Sales Officers for the Sales Upload "Select Sales Officer" control. */
export async function GET() {
  return handle(async () => ok(await listSalesOfficers(await requireAuth())));
}
