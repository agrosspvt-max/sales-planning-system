import "server-only";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";

/**
 * User Groups (MP / UP / WB / CG …). One Sales Officer belongs to at most one group
 * (User.groupId). Reuses the existing User model — no membership join table needed.
 */

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can manage groups");
}

export async function listGroups(ctx: AuthContext) {
  assertAdmin(ctx);
  const groups = (await prisma.userGroup.findMany({
    orderBy: { name: "asc" },
    include: {
      members: {
        where: { isActive: true, deletedAt: null },
        orderBy: { name: "asc" },
        select: { id: true, name: true, username: true },
      },
    },
  })) as { id: string; name: string; description: string | null; members: { id: string; name: string; username: string }[] }[];
  return groups.map((g) => ({ id: g.id, name: g.name, description: g.description, memberCount: g.members.length, members: g.members }));
}

/** Sales Officers not in any group (the "Unassigned" pool shown when adding to a group). */
export async function listUnassignedOfficers(ctx: AuthContext) {
  assertAdmin(ctx);
  const rows = (await prisma.user.findMany({
    where: { role: Role.SALES_OFFICER, isActive: true, deletedAt: null, groupId: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true, username: true },
  })) as { id: string; name: string; username: string }[];
  return rows;
}

const groupSchema = z.object({ name: z.string().min(1).max(80), description: z.string().max(300).optional() });

export async function createGroup(ctx: AuthContext, raw: unknown) {
  assertAdmin(ctx);
  const data = groupSchema.parse(raw);
  const group = await prisma.userGroup.create({ data: { name: data.name.trim(), description: data.description?.trim() || null } });
  await writeAudit({ userId: ctx.userId, action: "CREATE", entity: "userGroup", entityId: group.id, summary: `Created group ${group.name}` });
  return { id: group.id };
}

export async function updateGroup(ctx: AuthContext, id: string, raw: unknown) {
  assertAdmin(ctx);
  const data = groupSchema.parse(raw);
  await prisma.userGroup.update({ where: { id }, data: { name: data.name.trim(), description: data.description?.trim() || null } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "userGroup", entityId: id, summary: `Edited group ${data.name}` });
  return { ok: true };
}

/** Add Sales Officers to a group. Only officers NOT already in another group may be added. */
export async function addOfficersToGroup(ctx: AuthContext, groupId: string, raw: unknown) {
  assertAdmin(ctx);
  const { officerIds } = z.object({ officerIds: z.array(z.string().min(1)).min(1) }).parse(raw);
  const group = await prisma.userGroup.findUnique({ where: { id: groupId }, select: { name: true } });
  if (!group) throw new ApiError(404, "Group not found");

  // Guard: only unassigned (or already-in-this-group) active Sales Officers.
  const eligible = (await prisma.user.findMany({
    where: { id: { in: officerIds }, role: Role.SALES_OFFICER, isActive: true, deletedAt: null, OR: [{ groupId: null }, { groupId }] },
    select: { id: true },
  })) as { id: string }[];
  const ids = eligible.map((e) => e.id);
  if (ids.length === 0) throw new ApiError(422, "No eligible Sales Officers (already in another group?)");

  await prisma.user.updateMany({ where: { id: { in: ids } }, data: { groupId } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "userGroup", entityId: groupId, summary: `Added ${ids.length} officer(s) to group ${group.name}` });
  return { added: ids.length };
}

/** Remove an officer from its group → back to Unassigned. */
export async function removeOfficerFromGroup(ctx: AuthContext, officerId: string) {
  assertAdmin(ctx);
  const user = (await prisma.user.findUnique({ where: { id: officerId }, select: { name: true, groupId: true } })) as { name: string; groupId: string | null } | null;
  if (!user) throw new ApiError(404, "User not found");
  await prisma.user.update({ where: { id: officerId }, data: { groupId: null } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "userGroup", entityId: user.groupId ?? officerId, summary: `Removed ${user.name} from group` });
  return { ok: true };
}

export async function deleteGroup(ctx: AuthContext, id: string) {
  assertAdmin(ctx);
  const group = await prisma.userGroup.findUnique({ where: { id }, select: { name: true } });
  if (!group) throw new ApiError(404, "Group not found");
  await prisma.userGroup.delete({ where: { id } }); // members' groupId → null (FK onDelete SetNull)
  await writeAudit({ userId: ctx.userId, action: "DELETE", entity: "userGroup", entityId: id, summary: `Deleted group ${group.name}` });
  return { ok: true };
}
