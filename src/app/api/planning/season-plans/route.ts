import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createPlanSchema, createSeasonalPlanSchema } from "@/lib/validations/planning";
import { createSalesPlan, createSeasonalPlans, listPlans } from "@/features/planning/service.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const seasonId = req.nextUrl.searchParams.get("seasonId") ?? undefined;
    const mine = req.nextUrl.searchParams.get("mine") === "true";
    return ok(await listPlans(ctx, seasonId, mine));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const body = (await req.json()) as unknown;
    // New simplified Seasonal flow (season descriptor + officer selection). Falls back to
    // the legacy seasonId payload so existing callers keep working.
    if (body && typeof body === "object" && "season" in (body as Record<string, unknown>)) {
      const input = createSeasonalPlanSchema.parse(body);
      const { ids } = await createSeasonalPlans(ctx, input);
      return ok({ ids, id: ids[0] ?? null }, 201);
    }
    const input = createPlanSchema.parse(body);
    const id = await createSalesPlan(ctx, input);
    return ok({ id }, 201);
  });
}
