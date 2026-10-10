import { type NextRequest } from "next/server";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { actOnPartyPlan } from "@/features/party-planning/service.server";

// POST /api/party-plans/:id/act — Super Admin approves or rejects a submitted plan.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requirePartyAuth();
    const { id } = await ctx.params;
    return ok(await actOnPartyPlan(auth, id, await req.json()));
  });
}
