import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { schemeProductFollowUp, dealerProductFollowUp, parseFollowUpQuery } from "@/features/schemes/scheme-follow-up.server";

/**
 * PRODUCT BASED achievement follow-up (Phase 6). `view=scheme` → one row per PRODUCT_BASED scheme with its
 * enrolled dealers nested; `view=dealer` → one row per dealer aggregated across their PRODUCT_BASED schemes.
 * All numbers come from the Phase 4 engine; scope is enforced server-side by `getOfficerScope`. Read-only.
 */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const q = parseFollowUpQuery(req.nextUrl.searchParams);
    const view = req.nextUrl.searchParams.get("view") === "dealer" ? "dealer" : "scheme";
    return ok(view === "dealer" ? await dealerProductFollowUp(ctx, q) : await schemeProductFollowUp(ctx, q));
  });
}
