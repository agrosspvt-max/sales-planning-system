import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { commitPriceImport } from "@/features/import/prices/service.server";

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await commitPriceImport(ctx, await req.json()));
  });
}
