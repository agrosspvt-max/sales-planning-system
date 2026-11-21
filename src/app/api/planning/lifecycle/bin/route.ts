import { handle, ok, requireAuth } from "@/lib/http";
import { listSalesPlanBin } from "@/features/planning/sales-plan-bin.server";

export async function GET() {
  return handle(async () => ok(await listSalesPlanBin(await requireAuth())));
}
