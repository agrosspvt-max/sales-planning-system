import { handle, ok, requireAuth } from "@/lib/http";
import { getDaybookBillProducts } from "@/features/tally/daybook-bill-products.server";

export async function GET(req: Request) {
  return handle(async () =>
    ok(
      await getDaybookBillProducts(
        await requireAuth(),
        Object.fromEntries(new URL(req.url).searchParams),
      ),
    ),
  );
}
