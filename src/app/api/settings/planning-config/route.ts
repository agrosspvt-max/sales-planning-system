import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { loadPlanningConfig, updatePlanningConfig } from "@/features/settings/service.server";

export async function GET() {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await loadPlanningConfig(ctx));
  });
}

export async function PUT(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await updatePlanningConfig(ctx, await req.json()));
  });
}
