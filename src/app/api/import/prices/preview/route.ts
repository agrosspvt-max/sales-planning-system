import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { previewPrices } from "@/features/import/prices/service.server";

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await previewPrices(ctx, await req.json()));
  });
}
