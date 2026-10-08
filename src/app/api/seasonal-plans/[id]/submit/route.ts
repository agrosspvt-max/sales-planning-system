import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { submitSeasonalPlan } from "@/features/party-planning/seasonal.server";

// POST — submit the owner's draft / rejected plan for RM (SO) or Admin (RM) review.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await submitSeasonalPlan(await requireAuth(), id)); });
}
