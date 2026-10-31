import { handle, ok, requireAuth } from "@/lib/http";
import { salesStatus, salesRangeStatus } from "@/features/tally/sales.server";
export async function GET(req: Request) {
  return handle(async () => {
    const ctx = await requireAuth(),
      params = new URL(req.url).searchParams;
    return ok(
      params.has("fromMonth") || params.has("toMonth")
        ? await salesRangeStatus(ctx, params.get("fromMonth") ?? "", params.get("toMonth") ?? "")
        : await salesStatus(ctx, params.get("month") ?? ""),
    );
  });
}
