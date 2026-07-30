import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getProfileProvider } from "@/features/profiles/registry.server";

/**
 * @deprecated Superseded by the reusable profile layer: GET /api/profiles/officer/:id.
 * Kept only as a thin alias that delegates to the same provider (no separate logic).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const seasonId = req.nextUrl.searchParams.get("season") ?? undefined;
    return ok(await getProfileProvider("officer")!(auth, id, seasonId));
  });
}
