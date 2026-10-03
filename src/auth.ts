import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { authConfig } from "@/auth.config";
import { prisma } from "@/lib/prisma";
import { loginSchema } from "@/lib/validations/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError } from "@/lib/api-error";
import { mayEnterPage, type AdminPermissions } from "@/features/accounts/permissions";
import { assertApiAccess } from "@/features/accounts/route-permissions";

const nextAuth = NextAuth({
  ...authConfig,
  providers: [
    // Primary login used by Sales Officers, RMs and admins (username + password). UNCHANGED.
    Credentials({
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { username, password } = parsed.data;
        const user = await prisma.user.findUnique({ where: { username } });
        if (!user || !user.isActive || user.deletedAt) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        return {
          id: user.id,
          name: user.name,
          username: user.username,
          role: user.role,
        };
      },
    }),

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // TEMPORARY ADMIN BYPASS - REMOVE AFTER TESTING
    // Isolated, password-less provider (id "admin-bypass") that mints a NORMAL Super Admin JWT
    // session — identical to a real login, so all role/permission checks (which read the DB user in
    // requireAuth) behave exactly the same. It is used ONLY by the hidden /admin-access route and ONLY
    // when the env flag TEMP_ADMIN_BYPASS=true; otherwise authorize() returns null (no session). It does
    // NOT touch the primary "credentials" provider above or the /login page. Delete this whole block +
    // the /admin-access route + the /admin-access whitelist in auth.config.ts to fully remove it.
    Credentials({
      id: "admin-bypass",
      name: "Temporary Admin Bypass",
      credentials: {},
      authorize: async () => {
        if (process.env.TEMP_ADMIN_BYPASS !== "true") return null; // hard off-switch
        const admin = await prisma.user.findFirst({
          where: { role: Role.SUPER_ADMIN, isActive: true, deletedAt: null },
          orderBy: { createdAt: "asc" },
        });
        if (!admin) return null;
        return { id: admin.id, name: admin.name, username: admin.username, role: admin.role };
      },
    }),
    // END TEMPORARY ADMIN BYPASS
    // ─────────────────────────────────────────────────────────────────────────────────────────
  ],
});

export const { handlers, signIn, signOut } = nextAuth;
/** Custom grants are read from the DB, never authorized from JWT snapshots. */
export async function auth() {
  const session = await nextAuth.auth();
  if (session?.user?.role !== Role.CUSTOM_ADMIN) return session;
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: {
    id: true, role: true, name: true, username: true, isActive: true, deletedAt: true,
    sessionValidAfter: true, designation: true, adminPermissions: true,
  } });
  const h = await headers();
  const path = h.get("x-account-request-path");
  const api = path?.startsWith("/api/");
  if (!user || !user.isActive || user.deletedAt || user.role !== Role.CUSTOM_ADMIN ||
      (user.sessionValidAfter && (!session.user.iat || session.user.iat * 1000 < user.sessionValidAfter.getTime()))) {
    if (api) throw new ApiError(401, "Your session is no longer valid. Please sign in again.");
    redirect("/login");
  }
  session.user.name = user.name;
  session.user.username = user.username;
  session.user.designation = user.designation;
  session.user.permissions = user.adminPermissions as AdminPermissions;
  if (!path) throw new ApiError(403, "Request authorization context is unavailable.");
  if (api) assertApiAccess(session.user, path, h.get("x-account-request-method") ?? "");
  else if (!mayEnterPage(session.user, path)) redirect("/account?unavailable=1");
  return session;
}
