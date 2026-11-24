import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import {
  daybookStatus,
  daybookRangeStatus,
  requestDaybookRefresh,
  requestDaybookRangeRefresh,
} from "@/features/tally/daybook.server";
import { readBody, sameOrigin } from "@/features/tally/service.server";

export async function GET(req: Request) {
  return handle(async () => {
    const ctx = await requireAuth(),
      query = new URL(req.url).searchParams;
    return ok(
      query.has("fromMonth") || query.has("toMonth")
        ? await daybookRangeStatus(ctx, query.get("fromMonth") ?? "", query.get("toMonth") ?? "")
        : await daybookStatus(ctx, query.get("month") ?? ""),
    );
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    sameOrigin(req);
    const ctx = await requireAuth();
    const input = z
      .union([
        z.object({ month: z.string() }).strict(),
        z.object({ fromMonth: z.string(), toMonth: z.string() }).strict(),
      ])
      .parse(await readBody(req));
    return ok(
      "month" in input
        ? await requestDaybookRefresh(ctx, input.month)
        : await requestDaybookRangeRefresh(ctx, input.fromMonth, input.toMonth),
    );
  });
}
