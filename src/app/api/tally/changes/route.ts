import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { getRecoveryPlan } from "@/features/recovery/service.server";
import { assertEnabled, outstandingHistory } from "@/features/tally/service.server";

export async function GET(req: Request) {
  return handle(async () => {
    assertEnabled();
    const auth = await requireAuth();
    const planId = z.string().min(1).max(100).parse(new URL(req.url).searchParams.get("planId"));
    await getRecoveryPlan(auth, planId);
    return ok(await outstandingHistory(planId));
  });
}
