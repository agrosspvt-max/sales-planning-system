import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { unmergeProduct } from "@/features/products/merge.server";

/** Reverse a product merge (Super Admin). Safe + non-duplicating. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await unmergeProduct(auth, await req.json()));
  });
}
