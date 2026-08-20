import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { setRecoveryDealerNoPlan } from "@/features/recovery/service.server";

const schema = z.object({ noPlan: z.boolean(), reason: z.string().max(200).optional(), reasonDetail: z.string().max(500).optional() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; dealerId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id, dealerId } = await ctx.params;
    const { noPlan, reason, reasonDetail } = schema.parse(await req.json());
    return ok(await setRecoveryDealerNoPlan(auth, id, dealerId, noPlan, reason, reasonDetail));
  });
}
