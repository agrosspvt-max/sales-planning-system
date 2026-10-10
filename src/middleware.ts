import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { NextResponse } from "next/server";
import { partyPlanningGuard } from "@/lib/party-planning-guard";

const { auth: withAuth } = NextAuth(authConfig);

export const middleware = withAuth((req) => {
  // PARTY_PLANNING_ENABLED (fail-closed): a disabled Party Planning page / API is answered here, before any handler runs.
  const disabled = partyPlanningGuard(req.nextUrl.pathname, req.url);
  if (disabled) return disabled;
  // The `authorized` callback in authConfig decides access; this wrapper is
  // required so Next.js applies it as middleware.
  const headers = new Headers(req.headers);
  // Overwrite untrusted client headers on every page/API request.
  headers.set("x-account-request-path", req.nextUrl.pathname);
  headers.set("x-account-request-method", req.method);
  return NextResponse.next({ request: { headers } });
});

export default middleware;

export const config = {
  // Pages and APIs need trusted request context. API authentication remains in the
  // handlers so authorization failures retain JSON responses rather than redirects.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
