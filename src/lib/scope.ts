import "server-only";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";

export interface OfficerScope {
  all: boolean; // true for Super Admin (no restriction)
  ids: string[]; // officer ids the user may access (empty when all=true)
}

/**
 * Roles that may OWN a dealer (be the officer on a DealerAssignment). A Sales Officer manages their own
 * dealers; a Regional Manager also plans/owns their own dealers (the app already treats the RM as a
 * first-class planning contributor — see Territory Plan and `isPlanOwner`). Ownership uses the SAME
 * `DealerAssignment.officerId` relationship for both — there is no separate RM-ownership model.
 */
export const DEALER_OWNER_ROLES: Role[] = [Role.SALES_OFFICER, Role.REGIONAL_MANAGER];
export function isDealerOwnerRole(role: Role): boolean {
  return role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
}

/**
 * The set of officer ids whose data the current user may access.
 * - Super Admin: everyone (all=true).
 * - Regional Manager: every Sales Officer in the RM's OWN group, PLUS the RM themselves — so the RM
 *   sees the whole group's data and can also own/plan/submit their own plans (My Plans). Group scope
 *   is derived from `User.groupId` (one RM per group); the legacy RmAssignment table no longer drives it.
 * - Sales Officer: only themselves.
 */
export async function getOfficerScope(ctx: AuthContext): Promise<OfficerScope> {
  if (ctx.role === Role.SUPER_ADMIN) return { all: true, ids: [] };
  if (ctx.role === Role.SALES_OFFICER) return { all: false, ids: [ctx.userId] };

  // Regional Manager — group-scoped. An RM with no group sees only their own data.
  if (!ctx.groupId) return { all: false, ids: [ctx.userId] };
  const officers = await prisma.user.findMany({
    where: { role: Role.SALES_OFFICER, groupId: ctx.groupId, isActive: true, deletedAt: null },
    select: { id: true },
  });
  return { all: false, ids: [ctx.userId, ...officers.map((o) => o.id)] };
}

/**
 * True when the caller OWNS the plan identified by `officerId` — i.e. they are the officer on the plan.
 * A Sales Officer owns their own plans; a Regional Manager owns the plans they created for themselves
 * (My Plans). An RM is NOT the owner of another officer's plan, so this correctly blocks an RM from
 * editing/submitting on behalf of a group officer ("cannot submit as another officer"). Super Admin is
 * handled separately (they act on any plan without being the owner).
 */
export function isPlanOwner(ctx: AuthContext, officerId: string): boolean {
  return (ctx.role === Role.SALES_OFFICER || ctx.role === Role.REGIONAL_MANAGER) && officerId === ctx.userId;
}

/** Throw 403 unless the given officer is within the caller's scope. */
export async function assertOfficerInScope(ctx: AuthContext, officerId: string): Promise<void> {
  const scope = await getOfficerScope(ctx);
  if (scope.all) return;
  if (!scope.ids.includes(officerId)) {
    throw new ApiError(403, "You do not have access to this Sales Officer's data");
  }
}

/**
 * The current Regional Manager for an officer (approval routing), or null if none — in which case
 * submissions go straight to the Super Admin. The RM is the active REGIONAL_MANAGER in the officer's
 * group (group-based, one RM per group). An RM's OWN submission has no manager above them in the group
 * (the `id != officerId` guard) → returns null → routed to PENDING_ADMIN via the existing branch.
 */
export async function getCurrentManagerId(officerId: string): Promise<string | null> {
  const officer = await prisma.user.findUnique({ where: { id: officerId }, select: { groupId: true } });
  if (!officer?.groupId) return null;
  const rm = await prisma.user.findFirst({
    where: { role: Role.REGIONAL_MANAGER, groupId: officer.groupId, isActive: true, deletedAt: null, id: { not: officerId } },
    select: { id: true },
  });
  return rm?.id ?? null;
}

/** Dealers currently assigned to an officer (open-ended assignment). */
export async function getCurrentDealerIds(officerId: string): Promise<string[]> {
  const rows = await prisma.dealerAssignment.findMany({
    where: { officerId, effectiveTo: null },
    select: { dealerId: true },
  });
  return rows.map((r) => r.dealerId);
}
