import { handle, ok, requireAuth } from "@/lib/http";
import { getApprovalsInbox } from "@/features/planning/service.server";

export async function GET() {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await getApprovalsInbox(ctx));
  });
}
