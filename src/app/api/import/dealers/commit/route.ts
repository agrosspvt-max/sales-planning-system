import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { commitDealerImport } from "@/features/import/dealers/service.server";

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await commitDealerImport(ctx, await req.json()));
  });
}
