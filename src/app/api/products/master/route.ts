import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listProductMaster } from "@/features/users/catalogue.server";

/** Product Master with every group's price (dynamic) + category/brand options. */
export async function GET(_req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await listProductMaster(auth));
  });
}
