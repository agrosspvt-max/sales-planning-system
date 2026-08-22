import { handle, ok, requireAuth } from "@/lib/http";
import { eligibleSchemes } from "@/features/schemes/scheme-planning.server";

/** OPEN schemes applicable to the caller's State (for the Scheme Planning create flow). */
export async function GET() {
  return handle(async () => ok(await eligibleSchemes(await requireAuth())));
}
