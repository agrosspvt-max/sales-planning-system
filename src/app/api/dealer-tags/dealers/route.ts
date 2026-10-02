import { handle, ok, requireAuth } from "@/lib/http";
import { listTagDealers } from "@/features/dealer-tags/service.server";
export async function GET() {
  return handle(async () => ok(await listTagDealers(await requireAuth())));
}
