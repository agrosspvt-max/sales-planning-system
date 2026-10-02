import { handle, ok, requireAuth } from "@/lib/http";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { loadScopedDealerMarkerMap } from "@/lib/dealer-tags.server";

// GET /api/dealer-display-names — the alias-preferred DISPLAY name overrides for dealers that HAVE an alias.
// Returns ONLY overrides ({ dealerId: aliasName }); dealers without an alias are absent and callers fall back
// to the dealer's own name. This is display-only: no dealer record, id, ownership or history is affected.
export async function GET() {
  return handle(async () => {
    const ctx = await requireAuth();
    const [map, tags] = await Promise.all([loadDealerAliasNameMap(), loadScopedDealerMarkerMap(ctx)]);
    return ok({ overrides: Object.fromEntries(map), tags });
  });
}
