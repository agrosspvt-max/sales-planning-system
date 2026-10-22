import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { decideRetailerRequest } from "@/features/party-planning/retailer.server";

// POST { action: "approve" | "reject", reason? } — Admin. Approve creates the retailer + dealer links atomically; reject needs a reason.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await decideRetailerRequest(auth, id, await req.json().catch(() => ({}))));
  });
}
