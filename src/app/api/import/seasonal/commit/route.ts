import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { commitSeasonalImport } from "@/features/import/seasonal/service.server";

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await commitSeasonalImport(ctx, await req.json()));
  });
}
