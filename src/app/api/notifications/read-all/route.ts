import { handle, ok, requireAuth } from "@/lib/http";
import { markAllRead } from "@/features/notifications/service.server";

export async function POST() {
  return handle(async () => {
    const ctx = await requireAuth();
    await markAllRead(ctx);
    return ok({ success: true });
  });
}
