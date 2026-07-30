import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { getProfileProvider } from "@/features/profiles/registry.server";

/**
 * One reusable endpoint for every analytical profile:
 *   GET /api/profiles/:type/:id?season=...
 * The provider (officer, dealer, …) enforces its own data-level scope.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { type, id } = await ctx.params;
    const provider = getProfileProvider(type);
    if (!provider) throw new ApiError(404, `Unknown profile type: ${type}`);
    const seasonId = req.nextUrl.searchParams.get("season") ?? undefined;
    return ok(await provider(auth, id, seasonId));
  });
}
