import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { replaceSeasonalPlan } from "@/features/planning/lifecycle.server";

/**
 * Replace a Seasonal plan (Super Admin): archive the officer's active seasonal plan(s) for this
 * season so the subsequent Company Onboarding import becomes the single active plan. Returns the
 * officer + season so the UI can open the SHARED onboarding importer (no duplicate importer).
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await replaceSeasonalPlan(auth, id));
  });
}
