import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { actOnMarketRequest } from "@/features/party-planning/territory.server";

// POST { action: "approve" | "reject", reason? } — RM review, then Admin review (the service checks the role and the step).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = await requireAuth();
    const { id } = await params;
    return ok(await actOnMarketRequest(ctx, id, await req.json()));
  });
}
