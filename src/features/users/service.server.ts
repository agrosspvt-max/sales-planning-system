import "server-only";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, invalidateAuthCache, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { ROLE_LABELS } from "@/lib/rbac";

/**
 * User & Organization management. Reuses the existing User model, bcrypt hashing and audit —
 * no parallel auth. Deactivate/Delete are soft (isActive / deletedAt) so ALL history survives;
 * password changes and deactivation bump `sessionValidAfter` to invalidate existing sessions.
 */

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can manage users");
}

async function loadUserOr404(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true, isActive: true, deletedAt: true } });
  if (!u) throw new ApiError(404, "User not found");
  return u as { id: string; name: string; role: Role; isActive: boolean; deletedAt: Date | null };
}

const passwordSchema = z.string().min(6, "Password must be at least 6 characters");

/* --------------------- Regional Manager: one RM per group ------------------ */

/** Guard: a group may have at most one ACTIVE Regional Manager. Throws 409 if one already exists. */
async function assertNoOtherRmInGroup(groupId: string, excludeUserId?: string) {
  const existing = (await prisma.user.findFirst({
    where: { role: Role.REGIONAL_MANAGER, groupId, isActive: true, deletedAt: null, ...(excludeUserId ? { id: { not: excludeUserId } } : {}) },
    select: { id: true, name: true },
  })) as { id: string; name: string } | null;
  if (existing) throw new ApiError(409, `This group already has a Regional Manager (${existing.name}). Only one RM per group is allowed.`);
}

const createUserSchema = z.object({
  name: z.string().min(1).max(120),
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, "Username may use letters, numbers, dot, dash, underscore"),
  password: passwordSchema,
  role: z.enum([Role.SALES_OFFICER, Role.REGIONAL_MANAGER]),
  groupId: z.string().optional(),
});

/**
 * Create a Sales Officer OR a Regional Manager. Reuses the existing User model + bcrypt (no parallel
 * auth). A Regional Manager MUST belong to a group and is subject to the one-RM-per-group rule; a
 * Sales Officer's group is optional (assigned later). Super-Admin only.
 */
export async function createUser(ctx: AuthContext, raw: unknown) {
  assertAdmin(ctx);
  const data = createUserSchema.parse(raw);
  const username = data.username.trim().toLowerCase();
  const clash = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (clash) throw new ApiError(409, "That username is already taken");

  if (data.role === Role.REGIONAL_MANAGER) {
    if (!data.groupId) throw new ApiError(422, "A Regional Manager must belong to a group");
    const group = await prisma.userGroup.findUnique({ where: { id: data.groupId }, select: { id: true } });
    if (!group) throw new ApiError(422, "The selected group does not exist");
    await assertNoOtherRmInGroup(data.groupId);
  }

  const passwordHash = await bcrypt.hash(data.password, 10);
  const user = await prisma.user.create({
    data: { name: data.name.trim(), username, passwordHash, role: data.role, groupId: data.groupId || null },
    select: { id: true, name: true },
  });
  await writeAudit({ userId: ctx.userId, action: "CREATE", entity: "user", entityId: user.id, summary: `Created ${ROLE_LABELS[data.role]} ${user.name}` });
  return { id: user.id };
}

/** Promote a Sales Officer to Regional Manager (must already be in a group; one RM per group). */
export async function promoteToRegionalManager(ctx: AuthContext, userId: string) {
  assertAdmin(ctx);
  const user = (await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true, isActive: true, deletedAt: true, groupId: true } })) as
    | { id: string; name: string; role: Role; isActive: boolean; deletedAt: Date | null; groupId: string | null }
    | null;
  if (!user) throw new ApiError(404, "User not found");
  if (user.deletedAt || !user.isActive) throw new ApiError(409, "Only an active user can be promoted");
  if (user.role !== Role.SALES_OFFICER) throw new ApiError(409, "Only a Sales Officer can be promoted to Regional Manager");
  if (!user.groupId) throw new ApiError(422, "Assign the officer to a group before promoting them to Regional Manager");
  await assertNoOtherRmInGroup(user.groupId, userId);
  await prisma.user.update({ where: { id: userId }, data: { role: Role.REGIONAL_MANAGER } });
  invalidateAuthCache(userId); // a role change must take effect immediately
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "user", entityId: userId, summary: `Promoted ${user.name} to Regional Manager` });
  return { ok: true };
}

/** Demote a Regional Manager back to Sales Officer. Their group membership is kept. */
export async function demoteToSalesOfficer(ctx: AuthContext, userId: string) {
  assertAdmin(ctx);
  const user = await loadUserOr404(userId);
  if (user.role !== Role.REGIONAL_MANAGER) throw new ApiError(409, "Only a Regional Manager can be demoted");
  await prisma.user.update({ where: { id: userId }, data: { role: Role.SALES_OFFICER } });
  invalidateAuthCache(userId);
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "user", entityId: userId, summary: `Demoted ${user.name} to Sales Officer` });
  return { ok: true };
}

/* --------------------------- Password management -------------------------- */

/** Admin resets any user's password without the old one. Invalidates their sessions. */
export async function resetUserPassword(ctx: AuthContext, userId: string, raw: unknown) {
  assertAdmin(ctx);
  const { newPassword } = z.object({ newPassword: passwordSchema }).parse(raw);
  const user = await loadUserOr404(userId);
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash, sessionValidAfter: new Date() } });
  invalidateAuthCache(userId); // security change takes effect immediately, not after the TTL
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "user", entityId: userId, summary: `Reset password for ${user.name}` });
  return { ok: true };
}

/** A user changes their own password (old password required). Invalidates their other sessions. */
export async function changeOwnPassword(ctx: AuthContext, raw: unknown) {
  const { oldPassword, newPassword } = z
    .object({ oldPassword: z.string().min(1), newPassword: passwordSchema })
    .parse(raw);
  const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { passwordHash: true } });
  if (!user) throw new ApiError(404, "User not found");
  const valid = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!valid) throw new ApiError(422, "Your current password is incorrect");
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: ctx.userId }, data: { passwordHash, sessionValidAfter: new Date() } });
  invalidateAuthCache(ctx.userId);
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "user", entityId: ctx.userId, summary: "Changed own password" });
  return { ok: true };
}

/* ------------------------------ Edit profile ------------------------------ */

const editSchema = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().max(20).optional(),
  email: z.string().email().max(160).optional().or(z.literal("")),
});

export async function editUser(ctx: AuthContext, userId: string, raw: unknown) {
  assertAdmin(ctx);
  const data = editSchema.parse(raw);
  await loadUserOr404(userId);
  await prisma.user.update({
    where: { id: userId },
    data: { name: data.name.trim(), phone: data.phone?.trim() || null, email: data.email?.trim() || null },
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "user", entityId: userId, summary: `Edited user ${data.name}` });
  return { ok: true };
}

/* --------------------------- Lifecycle (soft) ----------------------------- */

export async function deactivateUser(ctx: AuthContext, userId: string) {
  assertAdmin(ctx);
  if (userId === ctx.userId) throw new ApiError(422, "You cannot deactivate your own account");
  const user = await loadUserOr404(userId);
  await prisma.user.update({ where: { id: userId }, data: { isActive: false, sessionValidAfter: new Date() } });
  invalidateAuthCache(userId);
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "user", entityId: userId, summary: `Deactivated ${user.name}` });
  return { ok: true };
}

export async function activateUser(ctx: AuthContext, userId: string) {
  assertAdmin(ctx);
  const user = await loadUserOr404(userId);
  if (user.deletedAt) throw new ApiError(409, "Deleted users cannot be reactivated");
  await prisma.user.update({ where: { id: userId }, data: { isActive: true } });
  invalidateAuthCache(userId);
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "user", entityId: userId, summary: `Activated ${user.name}` });
  return { ok: true };
}

/** Soft delete — never hard delete. Keeps every plan/approval/audit/upload record intact. */
export async function deleteUser(ctx: AuthContext, userId: string) {
  assertAdmin(ctx);
  if (userId === ctx.userId) throw new ApiError(422, "You cannot delete your own account");
  const user = await loadUserOr404(userId);
  await prisma.user.update({ where: { id: userId }, data: { isActive: false, deletedAt: new Date(), sessionValidAfter: new Date() } });
  invalidateAuthCache(userId);
  await writeAudit({ userId: ctx.userId, action: "DELETE", entity: "user", entityId: userId, summary: `Soft-deleted ${user.name}` });
  return { ok: true };
}

/* --------------------------------- Lists ---------------------------------- */

export type UserFilter = "active" | "inactive" | "deleted" | "all";

/** Sales Officers (and, when includeManagers=true, Regional Managers) for the management UI, with
 *  group + assigned-dealer counts. Soft-deleted hidden unless explicitly requested. Optionally scoped
 *  to one group. `includeManagers` defaults FALSE so planning officer-selectors that reuse this stay
 *  Sales-Officer-only; only the Users page opts in to also list RMs. Server-side filtering. */
export async function listOfficers(ctx: AuthContext, filter: UserFilter = "active", groupId?: string, includeManagers = false) {
  assertAdmin(ctx);
  const where: Record<string, unknown> = includeManagers
    ? { role: { in: [Role.SALES_OFFICER, Role.REGIONAL_MANAGER] } }
    : { role: Role.SALES_OFFICER };
  if (groupId) where.groupId = groupId;
  if (filter === "active") Object.assign(where, { isActive: true, deletedAt: null });
  else if (filter === "inactive") Object.assign(where, { isActive: false, deletedAt: null });
  else if (filter === "deleted") Object.assign(where, { deletedAt: { not: null } });
  // "all" → no status constraint.

  const rows = (await prisma.user.findMany({
    where,
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, username: true, role: true, isActive: true, deletedAt: true,
      group: { select: { id: true, name: true } },
      _count: { select: { dealerAssignments: true } },
    },
  })) as {
    id: string; name: string; username: string; role: Role; isActive: boolean; deletedAt: Date | null;
    group: { id: string; name: string } | null; _count: { dealerAssignments: number };
  }[];

  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    isManager: u.role === Role.REGIONAL_MANAGER,
    isActive: u.isActive,
    deleted: !!u.deletedAt,
    groupId: u.group?.id ?? null,
    groupName: u.group?.name ?? null,
    dealerCount: u._count.dealerAssignments,
  }));
}
