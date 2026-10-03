import type { Role } from "@prisma/client";
import type { DefaultSession } from "next-auth";
import type { AdminPermissions } from "@/features/accounts/permissions";

declare module "next-auth" {
  interface User {
    role: Role;
    username: string;
  }

  interface Session {
    user: {
      id: string;
      role: Role;
      username: string;
      /** JWT issued-at (seconds) — compared to User.sessionValidAfter to invalidate sessions. */
      iat?: number;
      designation?: string | null;
      permissions?: AdminPermissions;
      authenticationMethod?: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
    username: string;
    authenticationMethod?: string;
  }
}
