import { type NextRequest } from "next/server";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { getMonthlySheet } from "@/features/party-planning/monthly.server";

// GET ?stage=create|submitted|approved|older — ONE Monthly Plan by id: its season, month and rows (scope applied in the service).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await getMonthlySheet(await requirePartyAuth(), id, req.nextUrl.searchParams.get("stage") ?? undefined)); });
}
