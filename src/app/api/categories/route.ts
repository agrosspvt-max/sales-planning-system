import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listActiveCategories } from "@/features/products/categories.server";

export async function GET(_req: NextRequest) {
  return handle(async () => {
    await requireAuth();
    return ok(await listActiveCategories());
  });
}
