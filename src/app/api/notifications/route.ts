import { handle, ok, requireAuth } from "@/lib/http";
import { listNotifications, unreadCount } from "@/features/notifications/service.server";

export async function GET() {
  return handle(async () => {
    const ctx = await requireAuth();
    const [items, unread] = await Promise.all([listNotifications(ctx), unreadCount(ctx)]);
    return ok({ items, unread });
  });
}
