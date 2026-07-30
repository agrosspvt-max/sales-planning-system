import { type NextRequest } from "next/server";
import { z } from "zod";
import { PlanStatus } from "@prisma/client";
import { handle, ok, requireAuth } from "@/lib/http";
import { createMonthlyPlan, listMonthlyPlans } from "@/features/planning/monthly-plan.server";

const createSchema = z.object({
  seasonPlanId: z.string().min(1),
  seasonMonthId: z.string().min(1),
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const sp = req.nextUrl.searchParams;
    const seasonPlanId = sp.get("seasonPlanId") ?? undefined;
    const statusParam = sp.get("status");
    const statuses = statusParam
      ? (statusParam.split(",").filter(Boolean) as PlanStatus[])
      : undefined;
    return ok(await listMonthlyPlans(auth, { seasonPlanId, statuses }));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const { seasonPlanId, seasonMonthId } = createSchema.parse(await req.json());
    return ok(await createMonthlyPlan(auth, seasonPlanId, seasonMonthId));
  });
}
