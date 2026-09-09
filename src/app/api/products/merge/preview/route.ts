import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { previewMerge } from "@/features/products/merge.server";

/** Dry-run a product merge: catalogue/scheme impact + any blocking requirement conflicts. Read-only. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await previewMerge(auth, await req.json()));
  });
}
