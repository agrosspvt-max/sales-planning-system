import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { deleteSeasonalPlan, updateSeasonalPlan } from "@/features/party-planning/seasonal.server";

// PUT { marketId? } · DELETE — owner only, draft / rejected plans only (the service enforces it).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await updateSeasonalPlan(await requireAuth(), id, await req.json())); });
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await deleteSeasonalPlan(await requireAuth(), id)); });
}
