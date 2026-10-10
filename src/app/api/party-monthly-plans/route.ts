import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { createMonthlyPlan } from "@/features/party-planning/monthly.server";

// POST { sheetId, seasonalPlanId, planDate?, option1Party, option2Party? } — add a market row to the caller's Monthly Plan. Season and month come from that plan.
export async function POST(req: Request) {
  return handle(async () => ok(await createMonthlyPlan(await requirePartyAuth(), await req.json())));
}
