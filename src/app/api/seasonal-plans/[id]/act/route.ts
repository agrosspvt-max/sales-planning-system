import { type NextRequest } from "next/server";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { actOnSeasonalPlan } from "@/features/party-planning/seasonal.server";

// POST { action: "approve" | "reject", reason? } — RM review, then Admin final approval (role + step checked by the service).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await actOnSeasonalPlan(await requirePartyAuth(), id, await req.json())); });
}
