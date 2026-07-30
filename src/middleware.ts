import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export default middleware((req) => {
  // The `authorized` callback in authConfig decides access; this wrapper is
  // required so Next.js applies it as middleware.
  void req;
});

export const config = {
  // Protect page routes only. API routes self-guard via requireAuth/requirePermission,
  // so they are excluded here to keep JSON error responses (not HTML redirects).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
