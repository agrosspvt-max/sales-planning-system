import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { schemeOptionFollowUp, dealerOptionFollowUp, parseFollowUpQuery } from "@/features/schemes/scheme-follow-up.server";

/**
 * MULTIPLE OPTIONS achievement follow-up (Phase 10). `view=scheme` → one row per MULTIPLE_OPTIONS scheme with
 * its enrolled dealers GROUPED by their selected option; `view=dealer` → one row per dealer listing each of
 * their option schemes + selected option. Achievement is the combined total over the eligible pool vs each
 * dealer's frozen snapshot target. Scope is enforced server-side by `getOfficerScope`. Read-only.
 */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const q = parseFollowUpQuery(req.nextUrl.searchParams);
    const view = req.nextUrl.searchParams.get("view") === "dealer" ? "dealer" : "scheme";
    return ok(view === "dealer" ? await dealerOptionFollowUp(ctx, q) : await schemeOptionFollowUp(ctx, q));
  });
}
