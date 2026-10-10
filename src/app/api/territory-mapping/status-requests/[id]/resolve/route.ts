import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { resolveDealerStatusRequest } from "@/features/party-planning/territory.server";

// POST { notes? } — Admin marks the request resolved. Never edits the dealer.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await resolveDealerStatusRequest(auth, id, await req.json().catch(() => ({}))));
  });
}
