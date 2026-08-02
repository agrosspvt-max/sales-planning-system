import { type NextRequest } from "next/server";
import { PlanStatus } from "@prisma/client";
import { handle, ok, requireAuth } from "@/lib/http";
import { listRecoveryPlans } from "@/features/recovery/service.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const statusParam = req.nextUrl.searchParams.get("status");
    const statuses = statusParam ? (statusParam.split(",").filter(Boolean) as PlanStatus[]) : undefined;
    return ok(await listRecoveryPlans(auth, statuses));
  });
}
