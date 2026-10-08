import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { transitionOption } from "@/features/party-planning/monthly.server";

// POST { to, sent? | received? | reason? | actualPartyName? } — the service decides who may make the move and validates its data.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; optionNo: string }> }) {
  return handle(async () => { const { id, optionNo } = await params; return ok(await transitionOption(await requireAuth(), id, optionNo, await req.json())); });
}
