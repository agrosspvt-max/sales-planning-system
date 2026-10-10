import { type NextRequest } from "next/server";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { actOnMonthlySheet } from "@/features/party-planning/monthly.server";

// POST { action: "approve" | "reject", reason? } — RM (team plans) or Admin; role, scope and permission are checked by the service.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await actOnMonthlySheet(await requirePartyAuth(), id, await req.json())); });
}
