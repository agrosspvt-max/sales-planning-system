import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { getTransferOptions, transferRecoveryPlan } from "@/features/recovery/transfer.server";

const bodySchema = z.object({ targetSeasonPlanId: z.string().min(1) });

/** Current attachment + eligible destination Seasonal Plans for the transfer modal (Super Admin only). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await getTransferOptions(auth, id));
  });
}

/** Move this Recovery Plan to another Seasonal Plan (same officer & season). Super Admin only. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const { targetSeasonPlanId } = bodySchema.parse(await req.json());
    return ok(await transferRecoveryPlan(auth, id, targetSeasonPlanId));
  });
}
