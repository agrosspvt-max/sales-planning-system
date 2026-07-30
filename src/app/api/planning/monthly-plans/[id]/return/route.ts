import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { returnMonthlyPlan } from "@/features/planning/monthly-plan.server";

const schema = z.object({ remarks: z.string().min(1).max(1000) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const { remarks } = schema.parse(await req.json());
    return ok(await returnMonthlyPlan(auth, id, remarks));
  });
}
