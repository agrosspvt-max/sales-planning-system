import { handle, ok, requireAuth } from "@/lib/http";
import { readBody, sameOrigin } from "@/features/tally/service.server";
import { requestSalesRefresh } from "@/features/tally/sales.server";
import { z } from "zod";
export async function POST(req: Request) {
  return handle(async () => {
    sameOrigin(req);
    const ctx = await requireAuth();
    const input = z
      .object({ monthKey: z.string() })
      .strict()
      .parse(await readBody(req));
    return ok(await requestSalesRefresh(ctx, input.monthKey));
  });
}
