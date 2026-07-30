import "server-only";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";

export interface OfficerScope {
  all: boolean; // true for Super Admin (no restriction)
  ids: string[]; // officer ids the user may access (empty when all=true)
}

/**
 * The set of Sales Officers whose data the current user may access (§9, V16/V17).
 * - Super Admin: everyone.
 * - Regional Manager: officers currently assigned under them.
 * - Sales Officer: only themselves.
 */
export async function getOfficerScope(ctx: AuthContext): Promise<OfficerScope> {
  if (ctx.role === Role.SUPER_ADMIN) return { all: true, ids: [] };
  if (ctx.role === Role.SALES_OFFICER) return { all: false, ids: [ctx.userId] };

  // Regional Manager — current (open-ended) assignments only.
  const assignments = await prisma.rmAssignment.findMany({
    where: { managerId: ctx.userId, effectiveTo: null },
    select: { officerId: true },
  });
  return { all: false, ids: assignments.map((a) => a.officerId) };
}

/** Throw 403 unless the given officer is within the caller's scope. */
export async function assertOfficerInScope(ctx: AuthContext, officerId: string): Promise<void> {
  const scope = await getOfficerScope(ctx);
  if (scope.all) return;
  if (!scope.ids.includes(officerId)) {
    throw new ApiError(403, "You do not have access to this Sales Officer's data");
  }
}

/** The current Regional Manager for an officer, or null if they report directly to Super Admin. */
export async function getCurrentManagerId(officerId: string): Promise<string | null> {
  const assignment = await prisma.rmAssignment.findFirst({
    where: { officerId, effectiveTo: null },
    select: { managerId: true },
  });
  return assignment?.managerId ?? null;
}

/** Dealers currently assigned to an officer (open-ended assignment). */
export async function getCurrentDealerIds(officerId: string): Promise<string[]> {
  const rows = await prisma.dealerAssignment.findMany({
    where: { officerId, effectiveTo: null },
    select: { dealerId: true },
  });
  return rows.map((r) => r.dealerId);
}
