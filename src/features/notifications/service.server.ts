import "server-only";
import { NotificationType, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";

interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

/** Create a single notification (called directly by business workflows). */
export async function createNotification(input: NotifyInput): Promise<void> {
  await prisma.notification.create({ data: input });
}

/** Create the same notification for many users (skips empty lists). */
export async function notifyMany(userIds: string[], input: Omit<NotifyInput, "userId">): Promise<void> {
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return;
  await prisma.notification.createMany({
    data: unique.map((userId) => ({ ...input, userId })),
  });
}

export async function getSuperAdminIds(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { role: Role.SUPER_ADMIN, isActive: true },
    select: { id: true },
  });
  return admins.map((a) => a.id);
}

/* ------------------------------ Read / list ------------------------------- */

export async function listNotifications(ctx: AuthContext, limit = 30) {
  return prisma.notification.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function unreadCount(ctx: AuthContext): Promise<number> {
  return prisma.notification.count({ where: { userId: ctx.userId, isRead: false } });
}

export async function markRead(ctx: AuthContext, id: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id, userId: ctx.userId },
    data: { isRead: true },
  });
}

export async function markAllRead(ctx: AuthContext): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId: ctx.userId, isRead: false },
    data: { isRead: true },
  });
}

/* --------------------------- Announcement fan-out ------------------------- */

/** Recipients for an announcement based on its targeting (targetUser, audienceRole, or all). */
export async function announcementRecipientIds(a: {
  targetUserId: string | null;
  audienceRole: Role | null;
}): Promise<string[]> {
  if (a.targetUserId) return [a.targetUserId];
  const users = await prisma.user.findMany({
    where: { isActive: true, ...(a.audienceRole ? { role: a.audienceRole } : {}) },
    select: { id: true },
  });
  return users.map((u) => u.id);
}
