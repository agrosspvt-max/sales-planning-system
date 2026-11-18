import { handle, ok, requireAuth } from "@/lib/http";
import { missingProductsStatus } from "@/features/tally/missing-products.server";

export async function GET() {
  return handle(async () => ok(await missingProductsStatus(await requireAuth())));
}
