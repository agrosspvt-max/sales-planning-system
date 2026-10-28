import { z } from "zod";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { getRecoveryPlan } from "@/features/recovery/service.server";
import {
  assertEnabled,
  readBody,
  sameOrigin,
  requestRefresh,
} from "@/features/tally/service.server";
export async function POST(req: Request) {
  return handle(async () => {
    assertEnabled();
    sameOrigin(req);
    const auth = await requireAuth();
    const { planId } = z
      .object({ planId: z.string().min(1) })
      .strict()
      .parse(await readBody(req));
    const plan = await getRecoveryPlan(auth, planId);
    if (!plan.tallySyncAvailable)
      throw new ApiError(409, "Tally refresh is available for current active plans only");
    return ok(await requestRefresh());
  });
}
