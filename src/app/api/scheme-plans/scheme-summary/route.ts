import { handle, ok, requireAuth } from "@/lib/http";
import { schemeWiseSummary } from "@/features/schemes/scheme-planning.server";

/**
 * Scheme-wise summary for View Plan → Scheme-wise → List View. One row per scheme, aggregated
 * server-side and scoped by `getOfficerScope` (SO → own plans only). Read-only.
 */
export async function GET() {
  return handle(async () => ok(await schemeWiseSummary(await requireAuth())));
}
