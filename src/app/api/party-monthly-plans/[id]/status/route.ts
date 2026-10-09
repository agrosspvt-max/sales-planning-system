import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { changeRowStatus } from "@/features/party-planning/monthly.server";

// POST { to, sent? | received? | remarks? } — move the market row's operational status. Owner-vs-Admin step, plan approval and valid moves are checked by the service.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await changeRowStatus(await requireAuth(), id, await req.json())); });
}
