import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listTargetMonths } from "@/features/sales-upload/service.server";

export async function GET(_req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await listTargetMonths(auth));
  });
}
