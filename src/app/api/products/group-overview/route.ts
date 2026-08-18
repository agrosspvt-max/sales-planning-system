import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { productGroupOverview } from "@/features/users/catalogue.server";

/** Every Master product with its group availability/pricing (relationship view). */
export async function GET(_req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await productGroupOverview(auth));
  });
}
