import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { loadRecoveryConfig, updateRecoveryConfig } from "@/features/settings/service.server";

export async function GET() {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await loadRecoveryConfig(ctx));
  });
}

export async function PUT(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await updateRecoveryConfig(ctx, await req.json()));
  });
}
