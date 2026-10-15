import { handle, ok, requireAuth } from "@/lib/http";
import { listNotifications, unreadCount } from "@/features/notifications/service.server";
import { resolveNotificationLinks } from "@/features/notifications/links.server";

export async function GET() {
  return handle(async () => {
    const ctx = await requireAuth();
    const [items, unread] = await Promise.all([listNotifications(ctx), unreadCount(ctx)]);
    // Links are decided on the server from the entity each alert points to (current task date / exception details), never stored.
    const links = await resolveNotificationLinks(items);
    return ok({ items: items.map((n) => ({ ...n, href: links.get(n.id) ?? null })), unread });
  });
}
