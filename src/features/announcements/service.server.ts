import "server-only";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";

/** Active, targeted announcements for the current user (with read status). */
export async function listForUser(ctx: AuthContext, includeExpired = false) {
  const now = new Date();
  const windowClauses = includeExpired
    ? []
    : [{ activeFrom: { lte: now } }, { OR: [{ activeTo: null }, { activeTo: { gte: now } }] }];

  const anns = await prisma.announcement.findMany({
    where: {
      isActive: true,
      AND: [
        { OR: [{ audienceRole: null }, { audienceRole: ctx.role }, { targetUserId: ctx.userId }] },
        ...windowClauses,
      ],
    },
    include: { reads: { where: { userId: ctx.userId }, select: { id: true } } },
    orderBy: { createdAt: "desc" },
  });

  return anns.map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    audienceRole: a.audienceRole,
    activeTo: a.activeTo,
    createdAt: a.createdAt,
    isRead: a.reads.length > 0,
    isExpired: a.activeTo ? a.activeTo < now : false,
  }));
}

export async function markAnnouncementRead(ctx: AuthContext, announcementId: string): Promise<void> {
  await prisma.announcementReadStatus.upsert({
    where: { announcementId_userId: { announcementId, userId: ctx.userId } },
    create: { announcementId, userId: ctx.userId },
    update: {},
  });
}
