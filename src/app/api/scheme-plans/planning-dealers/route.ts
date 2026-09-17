import { handle, ok, requireAuth } from "@/lib/http";
import { planningDealerChoices } from "@/features/schemes/scheme-planning.server";

/** Current active dealer assignments plus existing dealer/scheme pairs for the SO dealer-first modal. */
export async function GET() {
  return handle(async () => ok(await planningDealerChoices(await requireAuth())));
}
