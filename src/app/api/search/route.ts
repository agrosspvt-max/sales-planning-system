import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { globalSearch } from "@/features/search/service.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const q = req.nextUrl.searchParams.get("q") ?? "";
    return ok(await globalSearch(ctx, q));
  });
}
