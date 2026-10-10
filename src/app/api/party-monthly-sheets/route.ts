import { type NextRequest } from "next/server";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { createMonthlySheet, listMonthlySheets } from "@/features/party-planning/monthly.server";
import { PLAN_STAGES, type PlanStage } from "@/lib/monthly-plan";

// GET ?season=<id>&needsAction=1 — the Monthly Plans the caller may see, across all seasons and months (scope applied in the service).
// POST { seasonId, seasonMonthId } — create the caller's Monthly Plan for a CHOSEN open season and one of its months.
export async function GET(req: NextRequest) {
  return handle(async () => {
    const q = req.nextUrl.searchParams;
    return ok(await listMonthlySheets(await requirePartyAuth(), { seasonId: q.get("season") || undefined, needsAction: q.get("needsAction") === "1", stage: (PLAN_STAGES as readonly string[]).includes(q.get("stage") ?? "") ? (q.get("stage") as PlanStage) : undefined }));
  });
}
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createMonthlySheet(await requirePartyAuth(), await req.json())));
}
