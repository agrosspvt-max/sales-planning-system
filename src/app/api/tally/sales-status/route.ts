import { handle, ok, requireAuth } from "@/lib/http";
import { salesStatus } from "@/features/tally/sales.server";
export async function GET(req: Request) {
  return handle(async () =>
    ok(await salesStatus(await requireAuth(), new URL(req.url).searchParams.get("month") ?? "")),
  );
}
