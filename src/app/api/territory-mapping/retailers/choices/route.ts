import { handle, ok, requireAuth } from "@/lib/http";
import { listRetailerDealerChoices } from "@/features/party-planning/retailer.server";

// GET — the requester's own current dealers (SO / RM) for the Linked Dealer(s) picker.
export async function GET() {
  return handle(async () => ok(await listRetailerDealerChoices(await requireAuth())));
}
