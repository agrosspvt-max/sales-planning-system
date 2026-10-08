import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateMonthlyPlan } from "@/features/party-planning/monthly.server";

// PUT { planDate?, option1Party?, option2Party? } — owner only (the service enforces it).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await updateMonthlyPlan(await requireAuth(), id, await req.json())); });
}
