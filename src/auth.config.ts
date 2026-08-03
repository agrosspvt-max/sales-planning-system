import type { NextAuthConfig } from "next-auth";
import type { Role } from "@prisma/client";

/**
 * Edge-safe auth configuration shared between middleware and the full server
 * instance. It must NOT import Node-only modules (bcrypt, Prisma). The
 * credentials provider (which needs those) is added only in `src/auth.ts`.
 */
export const authConfig = {
  pages: {
    signIn: "/login",
  },
  session: { strategy: "jwt" },
  providers: [],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isOnLogin = nextUrl.pathname.startsWith("/login");

      if (isOnLogin) {
        if (isLoggedIn) return Response.redirect(new URL("/dashboard", nextUrl));
        return true;
      }
      return isLoggedIn;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.role = user.role;
        token.username = user.username;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as Role;
        session.user.username = token.username as string;
        // Expose the JWT issued-at so requireAuth can invalidate sessions minted before a
        // password change / deactivation (User.sessionValidAfter).
        session.user.iat = token.iat as number | undefined;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
