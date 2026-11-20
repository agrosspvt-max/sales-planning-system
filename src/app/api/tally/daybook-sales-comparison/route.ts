import { handle, ok, requireAuth } from "@/lib/http";
import { compareDaybookSales } from "@/features/tally/daybook-sales-comparison.server";
export async function GET(req: Request) {
  return handle(async () =>
    ok(await compareDaybookSales(await requireAuth(), new URL(req.url).searchParams.get("jobId"))),
  );
}
