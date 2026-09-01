import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { schemeWiseSummary } from "@/features/schemes/scheme-planning.server";

/**
 * Scheme-wise summary for View Plan → Scheme-wise. Role-aware, one row per scheme (or per officer+scheme in
 * `groupByOfficer` mode). Column filters (`states`, `officers`, `booking`, `documents` — comma-separated)
 * are applied SERVER-SIDE before aggregation, so the returned metrics reflect the filtered population.
 * Scoped by `getOfficerScope`; `officerId` narrows to one Sales Officer; all validated server-side.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const list = (k: string) => (p.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return handle(async () =>
    ok(
      await schemeWiseSummary(await requireAuth(), {
        officerId: p.get("officerId") ?? undefined,
        groupByOfficer: p.get("groupByOfficer") === "true",
        filters: { states: list("states"), officerIds: list("officers"), booking: list("booking"), documents: list("documents") },
      }),
    ),
  );
}
