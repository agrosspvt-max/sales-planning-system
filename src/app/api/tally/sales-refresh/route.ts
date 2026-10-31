import { handle, ok, requireAuth } from "@/lib/http";
import { readBody, sameOrigin } from "@/features/tally/service.server";
import { requestSalesRefresh } from "@/features/tally/sales.server";
import { z } from "zod";
export async function POST(req: Request) {
  return handle(async () => {
    sameOrigin(req);
    const ctx = await requireAuth();
    const input = z
      .union([
        z.object({ monthKey: z.string() }).strict(),
        z.object({ fromMonth: z.string(), toMonth: z.string() }).strict(),
      ])
      .parse(await readBody(req));
    return ok(
      await requestSalesRefresh(
        ctx,
        "monthKey" in input ? input.monthKey : input.fromMonth,
        "toMonth" in input ? input.toMonth : undefined,
      ),
    );
  });
}
