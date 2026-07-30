import { handle, ok, requireAuth } from "@/lib/http";
import { loadAssignmentOptions } from "@/features/assignments/service.server";

export async function GET() {
  return handle(async () => {
    await requireAuth();
    return ok(await loadAssignmentOptions());
  });
}
