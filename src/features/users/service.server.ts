import "server-only";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, invalidateAuthCache, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";

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

/** Sales Officers for the management UI, with group + assigned-dealer counts. Soft-deleted hidden
 *  unless explicitly requested. Optionally scoped to one group (the Group detail page reuses this
 *  same endpoint). Server-side filtering — the UI never filters by status. */
export async function listOfficers(ctx: AuthContext, filter: UserFilter = "active", groupId?: string) {
  assertAdmin(ctx);
  const where: Record<string, unknown> = { role: Role.SALES_OFFICER };
  if (groupId) where.groupId = groupId;
  if (filter === "active") Object.assign(where, { isActive: true, deletedAt: null });
  else if (filter === "inactive") Object.assign(where, { isActive: false, deletedAt: null });
  else if (filter === "deleted") Object.assign(where, { deletedAt: { not: null } });
  // "all" → no status constraint.

  const rows = (await prisma.user.findMany({
    where,
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, username: true, isActive: true, deletedAt: true,
      group: { select: { id: true, name: true } },
      _count: { select: { dealerAssignments: true } },
    },
  })) as {
    id: string; name: string; username: string; isActive: boolean; deletedAt: Date | null;
    group: { id: string; name: string } | null; _count: { dealerAssignments: number };
  }[];

  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    isActive: u.isActive,
    deleted: !!u.deletedAt,
    groupId: u.group?.id ?? null,
    groupName: u.group?.name ?? null,
    dealerCount: u._count.dealerAssignments,
  }));
}
