import "server-only";
import { isAdministrativeRole } from "@/features/accounts/permissions";

import { Role, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { resolveCurrentOwner } from "@/lib/dealer-ownership";

/** Read-only client injection keeps tag authorization reads on the same transaction connection.
 * Defaults preserve every existing caller and all current ownership/hierarchy rules. */
export type ScopeReadClient = Pick<Prisma.TransactionClient, "user" | "dealerAssignment">;

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
export async function getOfficerScope(ctx: AuthContext, db: ScopeReadClient = prisma): Promise<OfficerScope> {
  if (isAdministrativeRole(ctx.role)) return { all: true, ids: [] };
  if (ctx.role === Role.SALES_OFFICER) return { all: false, ids: [ctx.userId] };

  // Regional Manager — group-scoped. An RM with no group sees only their own data.
  if (!ctx.groupId) return { all: false, ids: [ctx.userId] };
  const officers = await db.user.findMany({
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
export async function getCurrentManagerId(officerId: string, db: ScopeReadClient = prisma): Promise<string | null> {
  const officer = await db.user.findUnique({ where: { id: officerId }, select: { groupId: true } });
  if (!officer?.groupId) return null;
  const rm = await db.user.findFirst({
    where: { role: Role.REGIONAL_MANAGER, groupId: officer.groupId, isActive: true, deletedAt: null, id: { not: officerId } },
    select: { id: true },
  });
  return rm?.id ?? null;
}

/** Dealers currently assigned to an officer (open-ended assignment). If a dealer has more than one open
 *  assignment (a prior reassignment that failed to close an older row), it belongs ONLY to its most-recent
 *  owner — so a dealer never counts as "currently assigned" to two officers at once. */
export async function getCurrentDealerIds(officerId: string): Promise<string[]> {
  const mine = await prisma.dealerAssignment.findMany({
    where: { officerId, effectiveTo: null },
    select: { dealerId: true },
  });
  const ids = [...new Set(mine.map((r) => r.dealerId))];
  if (ids.length === 0) return [];
  const ownerByDealer = await getCurrentOwnerByDealer(ids);
  return ids.filter((id) => ownerByDealer.get(id) === officerId);
}

/**
 * Batched CURRENT owner per dealer (dealerId → current officerId), from the authoritative open-ended
 * DealerAssignment. One query for all the given dealers (no N+1). A dealer absent from the map has no current
 * assignment. Used by current-ownership views (Territory Plan/Recovery) so a reassigned dealer resolves to its
 * CURRENT officer only — never to the officer recorded on a historical plan row.
 */
export async function getCurrentOwnerByDealer(dealerIds: readonly string[], db: ScopeReadClient = prisma): Promise<Map<string, string>> {
  const ids = [...new Set(dealerIds)];
  if (ids.length === 0) return new Map();
  // Select effectiveFrom/createdAt too: if a dealer has more than one OPEN assignment (e.g. an older row that a
  // reassignment failed to close), resolveCurrentOwner deterministically keeps the MOST RECENT one, so the
  // current owner is never an older lingering officer.
  const rows = await db.dealerAssignment.findMany({
    where: { dealerId: { in: ids }, effectiveTo: null },
    select: { dealerId: true, officerId: true, effectiveFrom: true, createdAt: true },
  });
  const byDealer = new Map<string, { officerId: string; effectiveFrom: Date; createdAt: Date }[]>();
  for (const r of rows as { dealerId: string; officerId: string; effectiveFrom: Date; createdAt: Date }[]) {
    const list = byDealer.get(r.dealerId) ?? [];
    list.push({ officerId: r.officerId, effectiveFrom: r.effectiveFrom, createdAt: r.createdAt });
    byDealer.set(r.dealerId, list);
  }
  const out = new Map<string, string>();
  for (const [dealerId, list] of byDealer) {
    const owner = resolveCurrentOwner(list);
    if (owner) out.set(dealerId, owner);
  }
  return out;
}
