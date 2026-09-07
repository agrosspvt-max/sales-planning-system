import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { schemeValueFollowUp, dealerValueFollowUp, parseFollowUpQuery } from "@/features/schemes/scheme-follow-up.server";

/**
 * VALUE BASED achievement follow-up (Phase 6). `view=scheme` → one row per VALUE_BASED scheme (INDIVIDUAL or
 * COMBINED) with its enrolled dealers nested; `view=dealer` → one row per dealer aggregated across their
 * VALUE_BASED schemes. All numbers come from the Phase 4 engine; scope enforced server-side. Read-only.
 */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const q = parseFollowUpQuery(req.nextUrl.searchParams);
    const view = req.nextUrl.searchParams.get("view") === "dealer" ? "dealer" : "scheme";
    return ok(view === "dealer" ? await dealerValueFollowUp(ctx, q) : await schemeValueFollowUp(ctx, q));
  });
}
