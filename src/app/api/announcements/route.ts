import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listForUser } from "@/features/announcements/service.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const includeExpired = req.nextUrl.searchParams.get("filter") === "all";
    return ok(await listForUser(ctx, includeExpired));
  });
}
