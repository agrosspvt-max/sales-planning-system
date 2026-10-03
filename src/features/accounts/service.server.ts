import "server-only";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Role, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, invalidateAuthCache, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { ADMIN_MODULES, type AdminPermissions } from "./permissions";

type OwnerClient = Pick<Prisma.TransactionClient, "accountManagementOwner" | "user">;
export async function isAccountOwner(userId: string, role: Role, db: OwnerClient = prisma): Promise<boolean> {
  if (role !== Role.SUPER_ADMIN) return false;
  const owner = await db.accountManagementOwner.findUnique({ where: { id: "primary" }, select: { userId: true } });
  return owner?.userId === userId;
}
export async function requireAccountOwner(ctx: AuthContext, db: OwnerClient = prisma): Promise<void> {
  if (ctx.authenticationMethod !== "credentials") throw new ApiError(403, "Sign out and sign in with your normal username and password to use Account Management.");
  if (!await isAccountOwner(ctx.userId, ctx.role, db)) throw new ApiError(403, "Only the original Super Admin can manage administrative accounts.");
  const user = await db.user.findUnique({ where: { id: ctx.userId }, select: { role: true, isActive: true, deletedAt: true } });
  if (!user || user.role !== Role.SUPER_ADMIN || !user.isActive || user.deletedAt) throw new ApiError(403, "Account Management owner is unavailable.");
}
const permissionsSchema = z.record(z.array(z.string())).superRefine((grants, ctx) => {
  for (const [module, actions] of Object.entries(grants)) {
    const definition = ADMIN_MODULES.find(m => m.id === module);
    if (!definition || actions.some(a => !(definition.actions as readonly string[]).includes(a))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid permission: ${module}`, path: [module] });
    } else if (actions.length && !actions.includes("read")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Module access is required before granting actions.", path: [module] });
    }
  }
}).transform(grants => Object.fromEntries(Object.entries(grants).filter(([, a]) => a.length).map(([m, a]) => [m, [...new Set(a)].sort()])) as AdminPermissions);
const fields = {
  name: z.string().trim().min(1, "Full name is required.").max(120),
  username: z.string().trim().toLowerCase().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, "Use letters, numbers, dot, dash or underscore."),
  designation: z.string().trim().min(1, "Designation is required.").max(120),
  isActive: z.boolean(),
  permissions: permissionsSchema,
};
export const createAccountSchema = z.object({ ...fields, password: z.string().min(6).max(200) }).strict();
export const editAccountSchema = z.object({ ...fields, password: z.string().min(6).max(200).optional() }).strict();
const accountSelect = { id: true, name: true, username: true, designation: true, isActive: true, adminPermissions: true } as const;
export async function listAccounts(ctx: AuthContext) {
  await requireAccountOwner(ctx);
  const users = await prisma.user.findMany({ where: { role: Role.CUSTOM_ADMIN, deletedAt: null }, select: accountSelect, orderBy: { name: "asc" } });
  return users.map(({ adminPermissions, ...u }) => ({ ...u, permissions: adminPermissions as AdminPermissions }));
}
export async function createAccount(ctx: AuthContext, raw: unknown) {
  await requireAccountOwner(ctx);
  const data = createAccountSchema.parse(raw);
  const passwordHash = await bcrypt.hash(data.password, 10);
  return prisma.$transaction(async tx => {
    await requireAccountOwner(ctx, tx);
    const user = await tx.user.create({ data: { name: data.name, username: data.username, designation: data.designation,
      passwordHash, role: Role.CUSTOM_ADMIN, isActive: data.isActive, adminPermissions: data.permissions }, select: { id: true } });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "administrativeAccount", entityId: user.id,
      summary: JSON.stringify({ name: data.name, username: data.username, designation: data.designation, isActive: data.isActive, permissions: data.permissions }) }, tx);
    return user;
  });
}
export async function editAccount(ctx: AuthContext, id: string, raw: unknown) {
  await requireAccountOwner(ctx);
  const data = editAccountSchema.parse(raw);
  const passwordHash = data.password ? await bcrypt.hash(data.password, 10) : undefined;
  const result = await prisma.$transaction(async tx => {
    await requireAccountOwner(ctx, tx);
    // Serialize edits, so the audit before/after and revocation belong to this exact update.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${id} FOR UPDATE`;
    const previous = await tx.user.findUnique({ where: { id }, select: { ...accountSelect, role: true, deletedAt: true } });
    if (!previous || previous.role !== Role.CUSTOM_ADMIN || previous.deletedAt) throw new ApiError(404, "Administrative account not found.");
    await tx.user.update({ where: { id }, data: { name: data.name, username: data.username, designation: data.designation,
      isActive: data.isActive, adminPermissions: data.permissions, ...(passwordHash ? { passwordHash } : {}),
      // Permissions are read fresh; password/status changes also revoke all old credentials sessions.
      ...(passwordHash || previous.isActive !== data.isActive ? { sessionValidAfter: new Date() } : {}) } });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "administrativeAccount", entityId: id,
      summary: JSON.stringify({ before: { name: previous.name, username: previous.username, designation: previous.designation,
        isActive: previous.isActive, permissions: previous.adminPermissions }, after: { name: data.name, username: data.username,
        designation: data.designation, isActive: data.isActive, permissions: data.permissions }, passwordReset: !!passwordHash }) }, tx);
    return { id };
  });
  invalidateAuthCache(id);
  return result;
}
/** Delegated employee management cannot mutate the owner or other administrators via alternate APIs. */
export async function protectManagedUser(ctx: AuthContext, id: string, lifecycle = false) {
  const target = await prisma.user.findUnique({ where: { id }, select: { role: true } });
  if (target?.role === Role.CUSTOM_ADMIN) throw new ApiError(403, "Use owner-only Account Management for administrative accounts.");
  if (ctx.role === Role.CUSTOM_ADMIN && target?.role === Role.SUPER_ADMIN) throw new ApiError(403, "Administrative accounts cannot modify Super Admin accounts.");
  if (target?.role === Role.SUPER_ADMIN && await isAccountOwner(id, target.role)) {
    if (lifecycle) throw new ApiError(403, "The Account Management owner cannot be deactivated, deleted or reassigned.");
    // The passwordless bypass must not reset the owner's password and then mint a credentials JWT.
    await requireAccountOwner(ctx);
  }
}
