import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { daybookStatus, requestDaybookRefresh } from "@/features/tally/daybook.server";
import { readBody, sameOrigin } from "@/features/tally/service.server";

export async function GET(req: Request) {
  return handle(async () =>
    ok(await daybookStatus(await requireAuth(), new URL(req.url).searchParams.get("month") ?? "")),
  );
}

export async function POST(req: Request) {
  return handle(async () => {
    sameOrigin(req);
    const ctx = await requireAuth();
    const { month } = z
      .object({ month: z.string() })
      .strict()
      .parse(await readBody(req));
    return ok(await requestDaybookRefresh(ctx, month));
  });
}
