import "server-only";
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { assertAdminPermission } from "@/features/accounts/permissions";

import { Role, NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { createNotification } from "@/features/notifications/service.server";

/** Legacy free-text requests remain readable/declinable. They are not migrated or
 * assigned an invented year. All new extensions use Seasons → Add Months. */
export async function requestMonthExtension(ctx: AuthContext, _seasonId: string, _monthNameRaw: string): Promise<{ id: string }> {
  if (ctx.role !== Role.SALES_OFFICER && !isAdministrativeRole(ctx.role)) throw new ApiError(403, "Not permitted to request a month extension");
  throw new ApiError(410, "Free-text month requests are retired. Ask the Super Admin to use Seasons → Add Months.");
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
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, "Only a Super Admin can decide a month extension");
  assertAdminPermission(ctx, "approvals", approve ? "approve" : "reject");
  assertAdminPermission(ctx, "salesPlanning", approve ? "approve" : "reject");
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

  throw new ApiError(410, "Legacy requests do not specify a reliable calendar year. Use Seasons → Add Months; this request remains unchanged and may be declined.");
}
