import { handle, ok, requireAuth } from "@/lib/http";
import { listRetailers } from "@/features/party-planning/retailer.server";

// GET — approved retailers inside the viewer's scope (only their in-scope dealer links).
export async function GET() {
  return handle(async () => ok(await listRetailers(await requireAuth())));
}
