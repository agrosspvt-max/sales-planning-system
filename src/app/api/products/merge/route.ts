import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { mergeProducts, listProductMerges } from "@/features/products/merge.server";

/** GET → recent product merges (audit history). POST → perform a merge (Super Admin). */
export async function GET() {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await listProductMerges(auth));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await mergeProducts(auth, await req.json()));
  });
}
