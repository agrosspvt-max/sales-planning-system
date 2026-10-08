import { handle, ok, requireAuth } from "@/lib/http";
import { getMonthlyOptions } from "@/features/party-planning/monthly.server";

// GET — the OPEN seasons, their months (calendar order) and the caller's eligible-market counts, for the create dialog.
export async function GET() {
  return handle(async () => ok(await getMonthlyOptions(await requireAuth())));
}
