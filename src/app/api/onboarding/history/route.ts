import { handle, ok, requirePermission } from "@/lib/http";
import { listOnboardingRuns } from "@/features/onboarding/service.server";

export async function GET() {
  return handle(async () => {
    const ctx = await requirePermission("onboarding", "read");
    return ok(await listOnboardingRuns(ctx));
  });
}
