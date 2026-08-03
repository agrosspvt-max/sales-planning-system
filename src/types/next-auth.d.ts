import type { Role } from "@prisma/client";
import type { DefaultSession } from "next-auth";

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
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
    username: string;
  }
}
