import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { authConfig } from "@/auth.config";
import { prisma } from "@/lib/prisma";
import { loginSchema } from "@/lib/validations/auth";

export const { handlers, auth, signIn, signOut } = NextAuth({
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
