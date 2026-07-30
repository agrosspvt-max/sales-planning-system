import "server-only";
import { Role, NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { createNotification, notifyMany, getSuperAdminIds } from "@/features/notifications/service.server";

/**
 * Month Extension Requests. A Sales Officer asks to add a new (future) month to a Season.
 * NOTHING changes until a Super Admin approves — approval APPENDS a SeasonMonth (OPEN) to
 * the season and notifies the officer, after which the month becomes available when creating
 * monthly plans. Reuses the existing notification system; no new approval framework.
 */

const norm = (s: string) => s.trim().toLowerCase();

export async function requestMonthExtension(ctx: AuthContext, seasonId: string, monthNameRaw: string) {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.SUPER_ADMIN) {
    throw new ApiError(403, "Only a Sales Officer can request a month extension");
  }
  const monthName = monthNameRaw.trim();
  if (!monthName) throw new ApiError(422, "A month name is required");

  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { id: true } });
  if (!season) throw new ApiError(404, "Season not found");

  const months = await prisma.seasonMonth.findMany({ where: { seasonId }, select: { name: true, order: true } });
  // Duplicate months are not allowed.
  if (months.some((m) => norm(m.name) === norm(monthName))) {
    throw new ApiError(422, `"${monthName}" is already a month in this season`);
  }
  const pending = await prisma.monthExtensionRequest.findMany({
    where: { seasonId, status: "PENDING" },
    select: { monthName: true },
  });
  if (pending.some((p) => norm(p.monthName) === norm(monthName))) {
    throw new ApiError(409, `A pending request for "${monthName}" already exists`);
  }

  // New months append after the last month (future position).
  const monthOrder = months.reduce((mx, m) => Math.max(mx, m.order), 0) + 1;
  const req = await prisma.monthExtensionRequest.create({
    data: { seasonId, requestedById: ctx.userId, monthName, monthOrder, status: "PENDING" },
  });

  const requester = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
  await notifyMany(await getSuperAdminIds(), {
    type: NotificationType.MONTH_EXTENSION_REQUESTED,
    title: "Month extension requested",
    message: `${requester?.name ?? "A Sales Officer"} requested a new month "${monthName}".`,
    relatedEntityType: "MonthExtensionRequest",
    relatedEntityId: req.id,
  });
  return { id: req.id };
}

export async function listMonthExtensionRequests(ctx: AuthContext, status?: string) {
  // Admins see all; a Sales Officer sees their own requests.
  const scope = await getOfficerScope(ctx);
  const rows = await prisma.monthExtensionRequest.findMany({
    where: {
      status: status || undefined,
      requestedById: scope.all ? undefined : { in: scope.ids },
    },
    include: {
      season: { select: { name: true, year: true } },
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
    },
    orderBy: [{ createdAt: "desc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    seasonId: r.seasonId,
    seasonName: `${r.season.name} ${r.season.year}`,
    monthName: r.monthName,
    monthOrder: r.monthOrder,
    status: r.status,
    decisionNote: r.decisionNote,
    requestedById: r.requestedById,
    requestedByName: r.requestedBy.name,
    decidedByName: r.decidedBy?.name ?? null,
    decidedAt: r.decidedAt,
    createdAt: r.createdAt,
  }));
}

export async function decideMonthExtension(
  ctx: AuthContext,
  requestId: string,
  approve: boolean,
  note?: string,
) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can decide a month extension");
  const req = await prisma.monthExtensionRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new ApiError(404, "Request not found");
  if (req.status !== "PENDING") throw new ApiError(409, "This request has already been decided");

  if (!approve) {
    await prisma.monthExtensionRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED", decidedById: ctx.userId, decidedAt: new Date(), decisionNote: note },
    });
    await createNotification({
      userId: req.requestedById,
      type: NotificationType.SYSTEM,
      title: "Month extension declined",
      message: `Your request to add "${req.monthName}" was declined${note ? `: "${note}"` : "."}`,
      relatedEntityType: "MonthExtensionRequest",
      relatedEntityId: req.id,
    });
    return { status: "REJECTED" as const };
  }

  // Approve → append the month to the season (OPEN) atomically, guarding duplicates.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.seasonMonth.findMany({ where: { seasonId: req.seasonId }, select: { name: true, order: true } });
    if (existing.some((m) => norm(m.name) === norm(req.monthName))) {
      throw new ApiError(422, `"${req.monthName}" is already a month in this season`);
    }
    const nextOrder = existing.reduce((mx, m) => Math.max(mx, m.order), 0) + 1;
    await tx.seasonMonth.create({ data: { seasonId: req.seasonId, name: req.monthName, order: nextOrder, status: "OPEN" } });
    await tx.monthExtensionRequest.update({
      where: { id: requestId },
      data: { status: "APPROVED", decidedById: ctx.userId, decidedAt: new Date(), decisionNote: note, monthOrder: nextOrder },
    });
  });

  await createNotification({
    userId: req.requestedById,
    type: NotificationType.MONTH_EXTENSION_APPROVED,
    title: "New month available",
    message: `"${req.monthName}" has been added to the season and is now available for monthly planning.`,
    relatedEntityType: "Season",
    relatedEntityId: req.seasonId,
  });
  return { status: "APPROVED" as const };
}
